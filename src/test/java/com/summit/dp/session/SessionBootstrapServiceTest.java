package com.summit.dp.session;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionBootstrapService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionBootstrapVO;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionTreeVO;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * bootstrap 装配（§8.2）：信封字段、未决卡片的批量闸门、进行中轮次、执行身份化状态，以及
 * historyRevision 前后不一致时的有限重读。
 *
 * <p>钉住两条最关键的约束：<b>未决卡片的 gate 必须来自一次批量执行摘要</b>（禁止逐卡回查执行，
 * §7 / §8.2），以及 <b>executions 必须带 executionId</b>（否则前端无法定位 §8.1 退出路径 2
 * 的接续片段）。</p>
 */
class SessionBootstrapServiceTest {

    private static final long ROOT_ID = 500L;
    private static final long CHILD_ID = 501L;
    private static final long EXECUTION_ID = 9001L;
    private static final long TURN_ID = 8001L;

    private final SessionService sessionService = mock(SessionService.class);
    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ToolCallConverter toolCallConverter = mock(ToolCallConverter.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);

    private final SessionBootstrapService service = new SessionBootstrapService(
            sessionService, aggregateService, executionQueryService, toolCallRepository,
            toolCallConverter, chatTurnService, new ChatTurnConverter());

    private SessionMessagePageVO history;

    @BeforeEach
    void setup() {
        // 根会话存在且代际稳定为 7（前后一致）。
        when(aggregateService.requireOwned(ROOT_ID)).thenReturn(Session.builder().id(ROOT_ID)
                .historyRevision(7L).build());
        // 会话树解析：根为 ROOT_ID，含根 + 一个子会话。
        when(aggregateService.sessionTree(ROOT_ID)).thenReturn(new SessionAggregateService.SessionTree(
                ROOT_ID, List.of(
                        Session.builder().id(ROOT_ID).build(),
                        Session.builder().id(CHILD_ID).rootSessionId(ROOT_ID).build())));

        SessionVO root = SessionVO.builder().id(ROOT_ID).build();
        SessionVO child = SessionVO.builder().id(CHILD_ID).build();
        when(sessionService.tree(ROOT_ID)).thenReturn(Result.success(
                SessionTreeVO.builder().rootSessionId(ROOT_ID).sessions(List.of(root, child)).build()));

        history = SessionMessagePageVO.builder().hasMore(false).build();
        when(sessionService.messages(ROOT_ID, null, 50)).thenReturn(Result.success(history));
    }

    private static ToolCall promise(String id, long conversationId, Long executionId, ToolCallStatus status) {
        return ToolCall.builder()
                .id(id).conversationId(conversationId).executionId(executionId)
                .type(ToolCallType.PROMISE).status(status).toolName("ask_user")
                .build();
    }

    private void stubNoCardsNoTurnsNoExecutions() {
        when(toolCallRepository.listByConversationId(any())).thenReturn(List.of());
        when(chatTurnService.findActiveBySessionIds(any())).thenReturn(List.of());
        when(executionQueryService.activeBySession(any())).thenReturn(List.of());
    }

    @Test
    @DisplayName("信封字段：rootSessionId / historyRevision / 会话树 / 历史页逐项对应")
    void assemblesEnvelopeFields() {
        stubNoCardsNoTurnsNoExecutions();

        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        assertEquals(ROOT_ID, vo.getRootSessionId());
        assertEquals(7L, vo.getHistoryRevision());
        assertEquals(2, vo.getSessions().size());
        assertEquals(history, vo.getHistory());
        assertTrue(vo.getToolCalls().isEmpty());
        assertTrue(vo.getTurns().isEmpty());
        assertTrue(vo.getExecutions().isEmpty());
    }

    @Test
    @DisplayName("未决卡片：只保留未决、gate 从批量执行摘要映射、逐卡不回查执行")
    void unresolvedCardsGateComesFromBatchSummaries() {
        ToolCall suspended = promise("c-suspended", ROOT_ID, 1001L, ToolCallStatus.PENDING);
        ToolCall running = promise("c-running", ROOT_ID, 1002L, ToolCallStatus.PENDING);
        ToolCall missing = promise("c-missing", CHILD_ID, 1003L, ToolCallStatus.PENDING);
        ToolCall terminal = promise("c-terminal", CHILD_ID, 1004L, ToolCallStatus.PENDING);
        // 已收尾的卡片（status=COMPLETED）：isUnresolved()=false，必须被过滤掉。
        ToolCall completed = promise("c-completed", ROOT_ID, 1005L, ToolCallStatus.COMPLETED);

        when(toolCallRepository.listByConversationId(ROOT_ID)).thenReturn(List.of(suspended, running, completed));
        when(toolCallRepository.listByConversationId(CHILD_ID)).thenReturn(List.of(missing, terminal));
        when(executionQueryService.summariesByIds(any())).thenReturn(Map.of(
                1001L, summary(1001L, "SUSPENDED"),
                1002L, summary(1002L, "RUNNING"),
                // 1003 缺失 → UNKNOWN
                1004L, summary(1004L, "COMPLETED")));
        when(toolCallConverter.toVO(any(), any())).thenAnswer(call -> ToolCallVO.builder()
                .id(((ToolCall) call.getArgument(0)).getId()).build());
        when(chatTurnService.findActiveBySessionIds(any())).thenReturn(List.of());
        when(executionQueryService.activeBySession(any())).thenReturn(List.of());

        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        assertEquals(4, vo.getToolCalls().size(), "已收尾卡片必须被过滤");

        // 一次批量取摘要，且只取未决卡片涉及的执行 id。
        @SuppressWarnings("unchecked")
        ArgumentCaptor<java.util.Collection<Long>> idsCaptor = ArgumentCaptor.forClass(java.util.Collection.class);
        verify(executionQueryService).summariesByIds(idsCaptor.capture());
        assertEquals(4, idsCaptor.getValue().size());
        assertTrue(idsCaptor.getValue().containsAll(List.of(1001L, 1002L, 1003L, 1004L)));

        // 逐卡转换时传入的 gate 必须与摘要状态一一对应。
        ArgumentCaptor<CardAvailabilityPolicy.ExecutionGate> gateCaptor =
                ArgumentCaptor.forClass(CardAvailabilityPolicy.ExecutionGate.class);
        verify(toolCallConverter, times(4)).toVO(any(), gateCaptor.capture());
        List<CardAvailabilityPolicy.ExecutionGate> gates = gateCaptor.getAllValues();
        assertEquals(CardAvailabilityPolicy.ExecutionGate.SUSPENDED, gates.get(0));
        assertEquals(CardAvailabilityPolicy.ExecutionGate.ACTIVE, gates.get(1));
        assertEquals(CardAvailabilityPolicy.ExecutionGate.UNKNOWN, gates.get(2), "摘要缺失必须降级为 UNKNOWN");
        assertEquals(CardAvailabilityPolicy.ExecutionGate.NOT_SUSPENDED, gates.get(3));
    }

    @Test
    @DisplayName("进行中轮次：一次批量取，转为视图下发")
    void activeTurnsAreBatched() {
        when(toolCallRepository.listByConversationId(any())).thenReturn(List.of());
        ChatTurn active = ChatTurn.accept(TURN_ID, ROOT_ID, null, "deepseek-chat", "deepseek");
        when(chatTurnService.findActiveBySessionIds(any())).thenReturn(List.of(active));
        when(executionQueryService.activeBySession(any())).thenReturn(List.of());

        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        assertEquals(1, vo.getTurns().size());
        assertEquals(TURN_ID, vo.getTurns().getFirst().getTurnId());
        assertEquals("ACCEPTED", vo.getTurns().getFirst().getStatus());
        verify(chatTurnService).findActiveBySessionIds(List.of(ROOT_ID, CHILD_ID));
    }

    @Test
    @DisplayName("执行状态带 executionId：前端据此判 §8.1 退出路径 2")
    void executionStatesCarryExecutionIdentity() {
        when(toolCallRepository.listByConversationId(any())).thenReturn(List.of());
        when(chatTurnService.findActiveBySessionIds(any())).thenReturn(List.of());
        when(executionQueryService.activeBySession(any())).thenReturn(List.of(
                new ExecutionQueryService.ActiveExecution(EXECUTION_ID, ROOT_ID, "SUSPENDED",
                        Instant.parse("2026-10-04T00:00:00Z"), null)));

        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        assertEquals(1, vo.getExecutions().size());
        assertEquals("9001", vo.getExecutions().getFirst().executionId(), "executionId 不能为空，否则无法定位接续片段");
        assertEquals("500", vo.getExecutions().getFirst().sessionId());
        assertEquals("SUSPENDED", vo.getExecutions().getFirst().status());
        verify(executionQueryService).activeBySession(List.of(ROOT_ID, CHILD_ID));
    }

    @Test
    @DisplayName("historyRevision 读取中变更：有限重读，稳定后返回")
    void unstableRevisionTriggersBoundedReread() {
        // 每次「读取尝试」用两次 requireOwned（before/after）。
        // 序列 [1,2,2,2]：第 1 次尝试 before=1/after=2 → 不稳，重读；第 2 次 before=2/after=2 → 稳定。
        when(aggregateService.requireOwned(ROOT_ID)).thenReturn(
                Session.builder().id(ROOT_ID).historyRevision(1L).build(),
                Session.builder().id(ROOT_ID).historyRevision(2L).build(),
                Session.builder().id(ROOT_ID).historyRevision(2L).build(),
                Session.builder().id(ROOT_ID).historyRevision(2L).build());
        stubNoCardsNoTurnsNoExecutions();

        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        assertEquals(2L, vo.getHistoryRevision());
        verify(sessionService, times(2)).tree(ROOT_ID);
    }

    @Test
    @DisplayName("连续 3 次代际不稳：抛「历史正在变更」，不退化为无限重试")
    void permanentlyUnstableRevisionIsRejected() {
        when(aggregateService.requireOwned(ROOT_ID))
                .thenAnswer(call -> Session.builder().id(ROOT_ID).historyRevision(
                        System.nanoTime()).build());

        assertThrows(ClientException.class, () -> service.bootstrap(ROOT_ID));
        // 有限重读：最多 MAX_REVISION_RETRIES 次。
        verify(sessionService, times(3)).tree(ROOT_ID);
    }

    @Test
    @DisplayName("空 id 拒绝：不查库")
    void nullRootRejectedWithoutQueries() {
        assertThrows(ClientException.class, () -> service.bootstrap(null));
        verify(sessionService, never()).tree(any());
        verifyNoInteractionsGuard();
    }

    private void verifyNoInteractionsGuard() {
        verify(chatTurnService, never()).findActiveBySessionIds(anyCollection());
        verify(executionQueryService, never()).activeBySession(anyCollection());
    }

    private static ExecutionQueryService.ExecutionSummary summary(long id, String status) {
        return new ExecutionQueryService.ExecutionSummary(id, ROOT_ID, status, null, null);
    }
}

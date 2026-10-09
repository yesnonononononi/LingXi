package com.summit.dp.session;

import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewBroadcaster;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 块视图推送编排的回归守卫：路由用根会话、归属用自身会话，版本号来自轮次。
 *
 * <p><b>为什么这条不变量必须钉住</b>：{@code rootSessionId} 只用于传输路由，块内容的归属
 * 必须是 {@code TurnViewVO.sessionId}。两者混用会因子会话与根会话「哨兵 0」而投错桶 ——
 * 因此本用例断言「推给根、载荷带自身会话」两个值不相同。</p>
 */
class TurnViewBroadcasterTest {

    private static final long SESSION_ID = 100L;
    /**
     * 与 {@link #SESSION_ID} **必须不同**：这正是「归属与路由分开」这条不变量能被验证的前提。
     * 若两者相等，把载荷里的 sessionId 换成路由键就是一个等价变异，测试照样全绿 —— 那等于没测。
     */
    private static final long ROOT_SESSION_ID = 999L;
    private static final long TURN_ID = 8001L;
    private static final String EXECUTION_ID = "9001";

    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);

    private final TurnViewService turnViewService = new TurnViewService(
            messageRepository, chatTurnRepository, toolCallRepository,
            new TurnViewAssembler(new ObjectMapper(), mock(ToolBlockStatusResolver.class)));

    private final TurnViewBroadcaster broadcaster = new TurnViewBroadcaster(
            turnViewService, chatTurnRepository, sessionRepository, sseEventPublisher, executionIdentity);

    private ChatTurn runningTurn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, null, "deepseek-chat", "deepseek");
        turn.markRunning(java.time.Instant.now());
        return turn;
    }

    private void stubAiRound() {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("模型正文");
        ai.setThinking("模型思考");
        ai.setToolCalls(List.of(new ToolCallRequest("call-1", "read_file", 0, "{}")));
        String payload = new ObjectMapper().valueToTree(ai).toString();

        SessionMessage row = SessionMessage.builder()
                .id(11L).sessionId(SESSION_ID).turnId(TURN_ID).responseId("9007199254740993")
                .type(SessionMessageType.AI).text(payload).build();
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(List.of(row));
        when(toolCallRepository.listByIds(any())).thenReturn(List.of());
    }

    @Test
    @DisplayName("推给根会话，载荷归属写自身会话，事件名为约定的业务事件名")
    void routesToRootButCarriesOwnSession() {
        stubAiRound();
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(runningTurn()));
        when(sessionRepository.findById(SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(SESSION_ID).rootSessionId(0L).build()));
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        broadcaster.broadcastSnapshot(TURN_ID);

        ArgumentCaptor<String> name = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        ArgumentCaptor<Long> route = ArgumentCaptor.forClass(Long.class);
        verify(sseEventPublisher).publishBusiness(route.capture(), name.capture(), payload.capture());

        assertEquals(ROOT_SESSION_ID, route.getValue(), "路由必须用根会话");
        assertEquals(BlockEventType.TURN_SNAPSHOT, name.getValue());
        BlockEventType.BlockEventPayload event = (BlockEventType.BlockEventPayload) payload.getValue();
        assertEquals(SESSION_ID, event.sessionId(), "载荷归属是自身会话，不是路由键");
        assertTrue(ROOT_SESSION_ID != SESSION_ID, "前提：本用例的两个会话 id 必须不同，否则该断言是等价变异");
        assertEquals(TURN_ID, event.turnId());
        assertNotNull(event.view());
        assertEquals(TURN_ID, event.view().turnId());
        assertEquals("RUNNING", event.view().status());
    }

    @Test
    @DisplayName("轮次查不到时静默跳过，绝不推送也绝不抛异常")
    void missingTurnIsSilentlySkipped() {
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.empty());

        broadcaster.broadcastSnapshot(TURN_ID);

        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
    }

    @Test
    @DisplayName("根会话解析不出来时静默跳过（旁路推送不得把主流程顶成 500）")
    void unresolvableRootIsSkipped() {
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(runningTurn()));
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(null);

        broadcaster.broadcastSnapshot(TURN_ID);

        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
    }

    @Test
    @DisplayName("按执行推快照：先按 execution_id 反查轮次，再走上同一条推送编排")
    void snapshotByExecutionResolvesTurnFirst() {
        stubAiRound();
        when(chatTurnRepository.findByExecutionId(9001L)).thenReturn(Optional.of(runningTurn()));
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(runningTurn()));
        when(sessionRepository.findById(SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(SESSION_ID).rootSessionId(0L).build()));
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        broadcaster.broadcastSnapshotForExecution(EXECUTION_ID);

        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID),
                eq(BlockEventType.TURN_SNAPSHOT), any());
    }

    @Test
    @DisplayName("执行 ID 非数值（框架回落 UUID）时静默跳过，不猜轮次")
    void nonNumericExecutionIdIsSkipped() {
        broadcaster.broadcastSnapshotForExecution("not-a-number");

        verify(chatTurnRepository, never()).findByExecutionId(anyLong());
        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
    }

    @Test
    @DisplayName("块增量只下发变化的那一个块，不是整轮；整轮快照下发全部块")
    void blockUpsertCarriesOnlyTheChangedBlock() {
        stubAiRound();
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(runningTurn()));
        when(sessionRepository.findById(SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(SESSION_ID).rootSessionId(0L).build()));
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        // 增量：只带 call-1 这一个工具块（块身份规则 tool:<toolCallId>）。
        broadcaster.broadcastBlockUpsert(TURN_ID, "call-1");

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        ArgumentCaptor<String> name = ArgumentCaptor.forClass(String.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), name.capture(), payload.capture());
        assertEquals(BlockEventType.BLOCK_UPSERT, name.getValue());
        BlockEventType.BlockEventPayload event = (BlockEventType.BlockEventPayload) payload.getValue();
        assertEquals(1, event.view().blocks().size(), "增量必须只含变化的那一个块");
        assertEquals("tool:call-1", event.view().blocks().getFirst().getBlockId());

        // 对照：整轮快照带思考 + 正文 + 工具块共 3 块。
        org.mockito.Mockito.reset(sseEventPublisher);
        broadcaster.broadcastSnapshot(TURN_ID);
        ArgumentCaptor<Object> full = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), any(), full.capture());
        assertEquals(3, ((BlockEventType.BlockEventPayload) full.getValue()).view().blocks().size(),
                "整轮快照必须下发全部块");
    }

    @Test
    @DisplayName("增量过滤后为空则不推（该块此刻尚不存在，推空块会被前端读成「被清空」）")
    void emptyUpsertIsNotPublished() {
        stubAiRound();
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(runningTurn()));
        when(sessionRepository.findById(SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(SESSION_ID).rootSessionId(0L).build()));
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        broadcaster.broadcastBlockUpsert(TURN_ID, "call-not-exists");

        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
    }
}

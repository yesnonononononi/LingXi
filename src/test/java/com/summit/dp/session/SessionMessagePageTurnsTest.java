package com.summit.dp.session;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.vo.ChatTurnVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 历史接口的轮次装配（2026-10-01：归属彻底换成 turnId）。
 *
 * <p>钉住三件事：<b>归属直接取自消息行</b>（不再做「执行 ID → 轮次」映射）、
 * <b>批量</b>（一次 IN 装配字典，不是逐条查）、<b>归属校验</b>（只下发本会话的轮次）。</p>
 */
class SessionMessagePageTurnsTest {

    private static final long SESSION_ID = 700L;
    private static final long OTHER_SESSION_ID = 701L;
    private static final long TURN_ID = 8001L;

    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SessionMessageQueryService messageQueryService = mock(SessionMessageQueryService.class);
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final AgentRepository agentRepository = mock(AgentRepository.class);

    /** 必须先于 sessionService 声明：Java 字段初始化按声明顺序执行，否则传进去的是 null。 */
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);

    private final SessionServiceImpl sessionService = new SessionServiceImpl(
            aggregateService, workspaceService, sessionRepository, messageQueryService,
            executionQueryService, teamService, agentRepository,
            chatTurnService, new ChatTurnConverter());

    /** 造一页消息：存储态行带 turnId，视图也带同样的 turnId（归属来自消息行自身）。 */
    private void stubSliceWith(Long turnId) {
        SessionMessage stored = SessionMessage.builder()
                .id(9001L).sessionId(SESSION_ID).turnId(turnId)
                .type(SessionMessageType.USER).text("你好").build();
        when(aggregateService.messageSlice(SESSION_ID, null, null))
                .thenReturn(new CursorResult<>(List.of(stored), null, false));

        SessionMessageVO vo = SessionMessageVO.builder()
                .id(9001L).turnId(turnId).type("USER").text("你好").build();
        when(messageQueryService.query(any()))
                .thenReturn(new SessionMessageQueryService.SessionMessageQueryResult(List.of(vo), 0));
    }

    private static ChatTurn turn(long id, long sessionId, ChatTurnStatus status,
                                 Long totalTokens, Instant startedAt, Instant completedAt) {
        ChatTurn turn = ChatTurn.accept(id, sessionId, null, "deepseek-chat", "deepseek");
        if (status == ChatTurnStatus.RUNNING || status == ChatTurnStatus.COMPLETED) {
            turn.markRunning(startedAt);
        }
        if (status == ChatTurnStatus.COMPLETED) {
            turn.markCompleted(totalTokens == null ? null : 100L, totalTokens == null ? null : 50L,
                    totalTokens, completedAt);
        }
        return turn;
    }

    @Test
    @DisplayName("轮次字典以 turnId 字符串为键，字段完整，一次 IN 批量装配")
    void attachesTurnsKeyedByTurnId() {
        stubSliceWith(TURN_ID);
        Instant started = Instant.now().minus(30, ChronoUnit.SECONDS);
        Instant completed = Instant.now();
        when(chatTurnService.findByIds(any()))
                .thenReturn(Map.of(TURN_ID, turn(TURN_ID, SESSION_ID, ChatTurnStatus.COMPLETED,
                        150L, started, completed)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        Map<String, ChatTurnVO> turns = result.getData().getTurns();
        assertEquals(1, turns.size());
        ChatTurnVO vo = turns.get(String.valueOf(TURN_ID));
        assertNotNull(vo, "键必须是 turnId 的字符串形态（雪花 ID 走字符串避免前端精度丢失）");
        assertEquals(TURN_ID, vo.getTurnId());
        assertEquals("COMPLETED", vo.getStatus());
        assertEquals("deepseek-chat", vo.getModelName());
        assertEquals("deepseek", vo.getModelProvider());
        assertEquals(150L, vo.getTotalTokens());
        assertEquals(30_000L, vo.getElapsedMs(), "终态历时 = 结束 − 开始（含等待时间）");

        // 批量装配：一次 IN，不做逐条查询。
        verify(chatTurnService).findByIds(Set.of(TURN_ID));
    }

    @Test
    @DisplayName("归属直接取自消息行：不再做「执行 ID → 轮次」映射")
    void ownershipComesStraightFromTheMessageRow() {
        stubSliceWith(TURN_ID);
        when(chatTurnService.findByIds(any())).thenReturn(Map.of());

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        assertEquals(TURN_ID, result.getData().getRecords().getFirst().getTurnId(),
                "消息的 turnId 由存储态行直接带出，不需要任何映射");
        // 这条断言是本次改造的核心收益：历史分页不再为了归属多查一次 chat_turn。
        verify(chatTurnService, never()).findByExecutionIds(any());
    }

    @Test
    @DisplayName("归属校验：属于别的会话的轮次必须被丢弃，绝不跨会话下发")
    void dropsTurnsOwnedByAnotherSession() {
        stubSliceWith(TURN_ID);
        when(chatTurnService.findByIds(any()))
                .thenReturn(Map.of(TURN_ID, turn(TURN_ID, OTHER_SESSION_ID, ChatTurnStatus.COMPLETED,
                        150L, Instant.now().minusSeconds(5), Instant.now())));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        assertTrue(result.getData().getTurns().isEmpty(),
                "串到别的会话的轮次必须丢弃：统计口径错了比没有统计更糟");
    }

    @Test
    @DisplayName("旧消息没有轮次归属：不查轮次表、字典为空，消息照常下发")
    void legacyMessagesWithoutTurnProduceEmptyDict() {
        stubSliceWith(null);
        when(chatTurnService.findByIds(any())).thenReturn(Map.of());

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        assertTrue(result.getData().getTurns().isEmpty());
        assertNull(result.getData().getRecords().getFirst().getTurnId(), "归属未知保持 null，不伪造");
    }

    @Test
    @DisplayName("进行中轮次：elapsedMs 是「截至查询时刻」的已历时，completedAt 仍为空")
    void runningTurnMeasuresElapsedToNow() {
        stubSliceWith(TURN_ID);
        Instant started = Instant.now().minus(10, ChronoUnit.SECONDS);
        when(chatTurnService.findByIds(any()))
                .thenReturn(Map.of(TURN_ID, turn(TURN_ID, SESSION_ID, ChatTurnStatus.RUNNING,
                        null, started, null)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        ChatTurnVO vo = result.getData().getTurns().get(String.valueOf(TURN_ID));
        assertNull(vo.getCompletedAt(), "未结束不得写结束时间");
        assertNotNull(vo.getElapsedMs());
        assertTrue(vo.getElapsedMs() >= 10_000L, "已历时至少 10 秒（含等待时间），实际=" + vo.getElapsedMs());
    }

    @Test
    @DisplayName("未采集到用量时保持 null（前端显示「暂无统计」），绝不当成 0 消耗")
    void unknownUsageStaysNull() {
        stubSliceWith(TURN_ID);
        when(chatTurnService.findByIds(any()))
                .thenReturn(Map.of(TURN_ID, turn(TURN_ID, SESSION_ID, ChatTurnStatus.ACCEPTED,
                        null, null, null)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        ChatTurnVO vo = result.getData().getTurns().get(String.valueOf(TURN_ID));
        assertEquals("ACCEPTED", vo.getStatus(), "受理但未开始执行：状态仍可见");
        assertNull(vo.getInputTokens());
        assertNull(vo.getOutputTokens());
        assertNull(vo.getTotalTokens());
        assertNull(vo.getStartedAt());
        assertNull(vo.getElapsedMs(), "没有开始时间就没有历时可言，返回 0 会被读成「瞬间完成」");
    }
}

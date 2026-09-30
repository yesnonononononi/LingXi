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
import com.summit.dp.shared.vo.ExecutionSummaryVO;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.team.application.service.TeamService;
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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 历史接口的执行摘要装配（2026-09-30 改造）。
 *
 * <p>钉住三件事：<b>批量</b>（一次 IN，不是逐条）、<b>归属校验</b>（只装配本会话的执行）、
 * <b>空值语义</b>（未采集到的用量是 null，不是 0）。</p>
 *
 * <p>归属校验这一条尤其重要：缺了它，一个串错的 executionId 就能让 A 会话显示 B 会话的用量 ——
 * 统计口径错了比没有统计更糟。</p>
 */
class SessionMessagePageExecutionsTest {

    private static final long SESSION_ID = 700L;
    private static final long OTHER_SESSION_ID = 701L;
    private static final long EXECUTION_ID = 8001L;
    private static final long OTHER_EXECUTION_ID = 8002L;

    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SessionMessageQueryService messageQueryService = mock(SessionMessageQueryService.class);
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final AgentRepository agentRepository = mock(AgentRepository.class);

    private final SessionServiceImpl sessionService = new SessionServiceImpl(
            aggregateService, workspaceService, sessionRepository, messageQueryService,
            executionQueryService, teamService, agentRepository);

    private void stubSliceWith(Long executionId) {
        SessionMessage stored = SessionMessage.builder()
                .id(9001L).sessionId(SESSION_ID).executionId(executionId)
                .type(SessionMessageType.USER).text("你好").build();
        when(aggregateService.messageSlice(SESSION_ID, null, null))
                .thenReturn(new CursorResult<>(List.of(stored), null, false));

        SessionMessageVO vo = SessionMessageVO.builder()
                .id(9001L).executionId(executionId).type("USER").text("你好").build();
        when(messageQueryService.query(any()))
                .thenReturn(new SessionMessageQueryService.SessionMessageQueryResult(List.of(vo), 0));
    }

    private static ExecutionQueryService.ExecutionSummary summary(Long executionId, Long sessionId,
                                                                  String status, Long totalTokens,
                                                                  Instant startedAt, Instant completedAt) {
        return new ExecutionQueryService.ExecutionSummary(executionId, sessionId, status,
                "deepseek-chat", "deepseek", totalTokens == null ? null : 100L,
                totalTokens == null ? null : 50L, totalTokens, startedAt, completedAt);
    }

    @Test
    @DisplayName("本页涉及的执行摘要按 executionId 字符串为键下发，且一次批量装载")
    void attachesSummariesKeyedByExecutionId() {
        stubSliceWith(EXECUTION_ID);
        Instant started = Instant.now().minus(30, ChronoUnit.SECONDS);
        Instant completed = Instant.now();
        when(executionQueryService.summariesByIds(any()))
                .thenReturn(Map.of(EXECUTION_ID, summary(EXECUTION_ID, SESSION_ID, "COMPLETED", 150L,
                        started, completed)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        Map<String, ExecutionSummaryVO> executions = result.getData().getExecutions();
        assertEquals(1, executions.size());
        ExecutionSummaryVO vo = executions.get(String.valueOf(EXECUTION_ID));
        assertNotNull(vo, "键必须是 executionId 的字符串形态（雪花 ID 走字符串避免前端精度丢失）");
        assertEquals("COMPLETED", vo.getStatus());
        assertEquals("deepseek-chat", vo.getModelName());
        assertEquals("deepseek", vo.getModelProvider());
        assertEquals(150L, vo.getTotalTokens());
        assertEquals(30_000L, vo.getElapsedMs(), "终态历时 = 结束 − 开始（含等待时间）");

        // 批量装载：一次 IN 查询（入参是去重后的 executionId 集合），不做逐消息查询。
        verify(executionQueryService).summariesByIds(Set.of(EXECUTION_ID));
    }

    @Test
    @DisplayName("归属校验：属于别的会话的执行摘要必须被丢弃，绝不跨会话装配")
    void dropsSummariesOwnedByAnotherSession() {
        stubSliceWith(OTHER_EXECUTION_ID);
        when(executionQueryService.summariesByIds(any()))
                .thenReturn(Map.of(OTHER_EXECUTION_ID,
                        summary(OTHER_EXECUTION_ID, OTHER_SESSION_ID, "COMPLETED", 150L,
                                Instant.now().minusSeconds(5), Instant.now())));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        assertTrue(result.getData().getExecutions().isEmpty(),
                "串到别的会话的执行摘要必须丢弃：统计口径错了比没有统计更糟");
    }

    @Test
    @DisplayName("未采集到用量时保持 null（前端显示「暂无统计」），绝不当成 0 消耗")
    void unknownUsageStaysNull() {
        stubSliceWith(EXECUTION_ID);
        when(executionQueryService.summariesByIds(any()))
                .thenReturn(Map.of(EXECUTION_ID,
                        summary(EXECUTION_ID, SESSION_ID, "FAILED", null, null, null)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        ExecutionSummaryVO vo = result.getData().getExecutions().get(String.valueOf(EXECUTION_ID));
        assertNull(vo.getInputTokens());
        assertNull(vo.getOutputTokens());
        assertNull(vo.getTotalTokens());
        assertNull(vo.getStartedAt());
        assertNull(vo.getElapsedMs(), "没有开始时间就没有历时可言，返回 0 会被读成「瞬间完成」");
    }

    @Test
    @DisplayName("进行中执行：elapsedMs 是「截至查询时刻」的已历时，completedAt 仍为空")
    void runningExecutionMeasuresElapsedToNow() {
        stubSliceWith(EXECUTION_ID);
        Instant started = Instant.now().minus(10, ChronoUnit.SECONDS);
        when(executionQueryService.summariesByIds(any()))
                .thenReturn(Map.of(EXECUTION_ID,
                        summary(EXECUTION_ID, SESSION_ID, "RUNNING", 42L, started, null)));

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        ExecutionSummaryVO vo = result.getData().getExecutions().get(String.valueOf(EXECUTION_ID));
        assertNull(vo.getCompletedAt(), "未结束不得写结束时间");
        assertNotNull(vo.getElapsedMs());
        assertTrue(vo.getElapsedMs() >= 10_000L, "已历时至少 10 秒（含等待时间），实际=" + vo.getElapsedMs());
    }

    @Test
    @DisplayName("消息没有执行归属（旧数据）时不查执行表，摘要字典为空")
    void legacyMessagesWithoutExecutionSkipSummaryLookup() {
        stubSliceWith(null);

        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, null);

        assertTrue(result.getData().getExecutions().isEmpty());
        verify(executionQueryService, org.mockito.Mockito.never()).summariesByIds(any());
    }
}

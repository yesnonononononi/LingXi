package com.summit.dp.session;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentMatchers;

import java.util.Collection;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 会话视图出参回归（Phase 2）：list 与 tree 接口的展示状态组合出参
 * {@code runStatus}（IDLE/RUNNING/SUSPENDED，缺省 IDLE）与 {@code lastOutcome}
 * （COMPLETED/FAILED/CANCELLED，可空）。
 *
 * <p>展示状态由 {@code ExecutionQueryService} 查询时组合，会话自身不再持有执行状态。</p>
 */
class SessionViewRunStatusTest {

    private final SessionAggregateService aggregate = mock(SessionAggregateService.class);
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final SessionServiceImpl service = new SessionServiceImpl(aggregate, mock(WorkspaceService.class),
            mock(SessionRepository.class), mock(SessionMessageQueryService.class),
            executionQueryService,
            mock(com.summit.dp.team.application.service.TeamService.class),
            mock(AgentRepository.class),
            mock(ChatTurnService.class), new ChatTurnConverter());

    @Test
    @DisplayName("tree 出参组合：无执行→IDLE、RUNNING、SUSPENDED、完成后→IDLE+COMPLETED")
    void treeOutputsRunStatusAndLastOutcome() {
        Session idle = newSession(11L);
        Session running = newSession(12L);
        Session suspended = newSession(13L);
        Session done = newSession(14L);
        when(aggregate.sessionTree(10L)).thenReturn(new SessionAggregateService.SessionTree(
                10L, List.of(idle, running, suspended, done)));
        when(aggregate.countMessages(ArgumentMatchers.<Collection<Long>>any()))
                .thenReturn(Map.of(11L, 0L, 12L, 1L, 13L, 2L, 14L, 3L));
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of(
                12L, List.of(ExecutionState.RUNNING),
                13L, List.of(ExecutionState.SUSPENDED),
                14L, List.of(ExecutionState.COMPLETED)));

        List<SessionVO> nodes = service.tree(10L).getData().getSessions();

        assertEquals(4, nodes.size());
        assertEquals("IDLE", nodes.get(0).getRunStatus(), "无执行 → IDLE（缺省非空）");
        assertNull(nodes.get(0).getLastOutcome());
        assertEquals("RUNNING", nodes.get(1).getRunStatus());
        assertEquals("SUSPENDED", nodes.get(2).getRunStatus());
        assertEquals("IDLE", nodes.get(3).getRunStatus(), "无进行中 → IDLE");
        assertEquals("COMPLETED", nodes.get(3).getLastOutcome());
        assertEquals(List.of(0L, 1L, 2L, 3L), nodes.stream().map(SessionVO::getMessageCount).toList());
    }

    @Test
    @DisplayName("tree 出参 D1：上一轮 FAILED、本轮 RUNNING → 两字段同时非空")
    void treeOutputsRunningWithLastFailed() {
        Session session = newSession(21L);
        when(aggregate.sessionTree(20L)).thenReturn(new SessionAggregateService.SessionTree(20L, List.of(session)));
        when(aggregate.countMessages(ArgumentMatchers.<Collection<Long>>any())).thenReturn(Map.of(21L, 0L));
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of(
                21L, List.of(ExecutionState.RUNNING, ExecutionState.FAILED)));

        SessionVO node = service.tree(20L).getData().getSessions().get(0);

        assertEquals("RUNNING", node.getRunStatus());
        assertEquals("FAILED", node.getLastOutcome(), "上一轮终态与本轮进行态独立并存");
    }

    @Test
    @DisplayName("list 出参携带 runStatus/lastOutcome；无执行会话缺省 IDLE + null")
    void listOutputsRunStatusAndLastOutcome() {
        Session fresh = newSession(1L);
        Session running = newSession(2L);
        Page<Session> page = new Page<>(1, 10, 2);
        page.setRecords(List.of(fresh, running));
        when(aggregate.page(1, 10)).thenReturn(page);
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of(
                2L, List.of(ExecutionState.RUNNING, ExecutionState.CANCELLED)));

        List<SessionVO> records = List.copyOf(service.list(1, 10).getData().getRecords());

        assertEquals(2, records.size());
        assertEquals("IDLE", records.get(0).getRunStatus(), "无执行 → IDLE");
        assertNull(records.get(0).getLastOutcome());
        assertEquals("RUNNING", records.get(1).getRunStatus());
        assertEquals("CANCELLED", records.get(1).getLastOutcome());
        assertNull(records.get(0).getMessageCount(), "未查询消息条数时不能输出假零值");
    }

    @Test
    @DisplayName("VO 出参 teamId：可空透传，未绑定输出 null，前端无需判空转义")
    void voOutputsTeamIdNullSafe() {
        Session bound = newSession(31L).toBuilder().teamId(9L).build();
        Session unbound = newSession(32L);
        Page<Session> page = new Page<>(1, 10, 2);
        page.setRecords(List.of(bound, unbound));
        when(aggregate.page(1, 10)).thenReturn(page);
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of());

        List<SessionVO> records = List.copyOf(service.list(1, 10).getData().getRecords());

        assertEquals(9L, records.get(0).getTeamId());
        assertNull(records.get(1).getTeamId(), "非团队会话 teamId 输出 null");
    }

    @ParameterizedTest
    @MethodSource("detailStates")
    void detailSelectsLatestActiveAndTerminalIndependently(List<ExecutionState> states,
                                                         String expectedRunStatus, String expectedOutcome) {
        when(aggregate.requireOwned(1L)).thenReturn(newSession(1L));
        when(executionQueryService.latestStatesBySession(List.of(1L))).thenReturn(Map.of(1L, states));

        SessionVO view = service.findById(1L).getData();

        assertEquals(expectedRunStatus, view.getRunStatus());
        assertEquals(expectedOutcome, view.getLastOutcome());
    }

    @Test
    void unifiedViewPreservesTreeFieldsAndStringIds() {
        long sessionId = 9007199254740993L;
        Instant updatedAt = Instant.parse("2026-09-28T12:00:00Z");
        Session session = newSession(sessionId).toBuilder()
                .updateTime(updatedAt).workspaceId(7L).teamId(8L).build();
        when(aggregate.sessionTree(sessionId)).thenReturn(
                new SessionAggregateService.SessionTree(sessionId, List.of(session)));
        when(aggregate.requireOwned(sessionId)).thenReturn(session);
        when(aggregate.countMessages(List.of(sessionId))).thenReturn(Map.of());
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of());

        SessionVO node = service.tree(sessionId).getData().getSessions().getFirst();
        SessionVO detail = service.findById(sessionId).getData();
        ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
        JsonNode treeJson = objectMapper.valueToTree(node);
        JsonNode detailJson = objectMapper.valueToTree(detail);

        assertEquals(updatedAt, node.getUpdateTime());
        assertEquals(updatedAt, detail.getUpdateTime());
        assertTrue(treeJson.get("id").isTextual());
        assertEquals(Long.toString(sessionId), treeJson.get("id").asText());
        assertEquals("0", treeJson.get("rootSessionId").asText());
        assertTrue(treeJson.get("workspaceId").isTextual());
        assertTrue(treeJson.get("teamId").isTextual());
        assertEquals(0L, treeJson.get("messageCount").asLong());
        assertFalse(detailJson.has("messageCount"));
    }

    private static Object[][] detailStates() {
        return new Object[][]{
                {List.of(), "IDLE", null},
                {List.of(ExecutionState.CREATED), "RUNNING", null},
                {List.of(ExecutionState.FAILED), "IDLE", "FAILED"},
                {List.of(ExecutionState.CANCELLED), "IDLE", "CANCELLED"},
                {List.of(ExecutionState.SUSPENDED, ExecutionState.RUNNING, ExecutionState.COMPLETED,
                        ExecutionState.FAILED), "SUSPENDED", "COMPLETED"},
                {List.of(ExecutionState.FAILED, ExecutionState.CREATED, ExecutionState.CANCELLED,
                        ExecutionState.SUSPENDED), "RUNNING", "FAILED"}
        };
    }

    /** 构造一个最少字段的会话；运行态由 ExecutionQueryService 组合，不在会话上承载。 */
    private static Session newSession(Long id) {
        return Session.builder()
                .id(id)
                .rootSessionId(Session.ROOT_SESSION_ID)
                .name("状态出参测试")
                .build();
    }
}

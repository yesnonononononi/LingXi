package com.summit.dp.workflow.infrastructure.tools.sub_agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 队员状态查询：参数是模型下发的原始 JSON（不是裸数字）、队员未唤醒时只回文案且不派生会话。
 */
class PeekTeammateStateToolTest {

    private static final long ROOT_SESSION_ID = 100L;
    private static final long TEAM_ID = 7L;
    private static final long AGENT_ID = 12L;
    private static final long SUB_SESSION_ID = 555L;

    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SessionService sessionService = mock(SessionService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final PeekTeammateStateTool tool = new PeekTeammateStateTool(
            new ObjectMapper(), sessionService, sessionRepository, teamService);

    @ParameterizedTest
    @ValueSource(strings = {"{\"agentId\":12}", "{\"agentId\":12,\"agentName\":\"展示名\"}"})
    @DisplayName("携带或省略展示名均能按 agentId 查询，回执名称取自团队名单")
    void readsRunStatusFromJsonArguments(String args) {
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(team()));
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(SUB_SESSION_ID).build()));
        when(sessionService.findById(SUB_SESSION_ID)).thenReturn(Result.success(SessionVO.builder()
                .id(SUB_SESSION_ID).runStatus("RUNNING").lastOutcome("COMPLETED").build()));

        ToolExecuteResult result = tool.execute(toolExecution(args, sessionAttributes()));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("队员 编码 当前状态: RUNNING, 最近结果: COMPLETED, 子会话: 555", result.getToolOutput());
        verify(sessionRepository).findByRootAndAgent(ROOT_SESSION_ID, AGENT_ID);
    }

    @Test
    @DisplayName("队员从未被委派：只回「尚未被唤醒」，不查会话详情、不派生新会话")
    void neverWokenTeammateDoesNotCreateSession() {
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(team()));
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, AGENT_ID)).thenReturn(Optional.empty());

        ToolExecuteResult result = tool.execute(toolExecution("{\"agentId\":12}", sessionAttributes()));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("尚未被唤醒"), result.getToolOutput());
        verify(sessionService, never()).findById(anyLong());
        verify(sessionRepository, never()).saveAndReturnId(any());
    }

    @Test
    @DisplayName("不在团队上下文：回中文业务提示，不落成框架兜底的 Tool execution error")
    void missingTeamReportsBusinessMessage() {
        Map<String, Object> attributes = Map.of(ExecutionAttributes.SESSION_ID, ROOT_SESSION_ID);

        ToolExecuteResult result = tool.execute(toolExecution("{\"agentId\":12}", attributes));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("团队"), result.getToolOutput());
        verify(teamService, never()).findById(anyLong());
    }

    @Test
    @DisplayName("agentId 缺失：直接回参数提示，不查库")
    void missingAgentIdIsRejected() {
        ToolExecuteResult result = tool.execute(toolExecution("{}", sessionAttributes()));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("agentId"), result.getToolOutput());
        verify(teamService, never()).findById(anyLong());
    }

    @Test
    @DisplayName("队员（子执行）调用：直接拒绝，且不查任何一张表")
    void memberCannotPeek() {
        Map<String, Object> memberAttributes = Map.of(
                ExecutionAttributes.SESSION_ID, SUB_SESSION_ID,
                ExecutionAttributes.ROOT_SESSION_ID, ROOT_SESSION_ID,
                ExecutionAttributes.TEAM_ID, TEAM_ID);

        ToolExecuteResult result = tool.execute(toolExecution("{\"agentId\":12}", memberAttributes));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("指挥者"), result.getToolOutput());
        verify(teamService, never()).findById(anyLong());
        verify(sessionRepository, never()).findByRootAndAgent(any(), any());
    }

    private static Map<String, Object> sessionAttributes() {
        return Map.of(ExecutionAttributes.SESSION_ID, ROOT_SESSION_ID, ExecutionAttributes.TEAM_ID, TEAM_ID);
    }

    private static ToolExecution toolExecution(String args, Map<String, Object> attributes) {
        return ToolExecution.builder().args(args).attributes(attributes).build();
    }

    private static TeamVO team() {
        AgentVO agent = new AgentVO();
        agent.setId(AGENT_ID);
        agent.setName("编码");
        return TeamVO.builder().id(TEAM_ID).commanderAgentId(99L).agents(List.of(agent)).build();
    }
}

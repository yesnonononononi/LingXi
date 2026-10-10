package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.team.application.service.TeamService;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 团队身份随 AgentRequest attributes 流动的回归守卫：
 * {@link CallSubAgentTool} 只从工具执行上下文的 attributes 解析 TEAM_ID，不再读任何
 * ThreadLocal —— 挂起 → 审批 → resume 后跑在任意线程（Tomcat / 虚拟线程）上同样解析正确。
 */
class CallSubAgentTeamResolutionTest {

    private final AgentService agents = mock(AgentService.class);
    private final TeamService teams = mock(TeamService.class);

    /** 入口编排只依赖 agentService + teamService，其余构造参数可空。 */
    private CallSubAgentTool tool() {
        return new CallSubAgentTool(new ObjectMapper(), agents, teams, null,
                null, null, null, null, null);
    }

    private ToolExecution execution(Map<String, Object> attributes) {
        ToolExecution execution = mock(ToolExecution.class);
        when(execution.getArgs()).thenReturn("{\"agentId\":7,\"task\":\"work\",\"workDir\":\"/work\"}");
        when(execution.getAttributes()).thenReturn(attributes);
        return execution;
    }

    private void agentWithModel() {
        AgentVO agent = new AgentVO();
        agent.setId(7L);
        agent.setModelId(3L);
        when(agents.findById(7L)).thenReturn(Result.success(agent));
    }

    @Test
    void teamIdResolvesFromExecutionAttributes() {
        agentWithModel();
        when(teams.findById(1L)).thenReturn(Result.success(null));

        ToolExecuteResult result = tool().execute(execution(Map.of(ExecutionAttributes.TEAM_ID, "1")));

        // TEAM_ID 从 attributes 正确解析为 1 并用于团队查询（团队缺位，错误信息必须携带该 ID）
        assertTrue(result.getToolOutput().contains("未找到指定的团队: 1"));
        assertFalse(result.getToolOutput().contains("未确定当前协作团队"));
    }

    @Test
    void teamIdResolvesFromSnapshotJsonRoundTripValue() {
        // 快照 JSON 往返后数值可能退化为 Integer/Long，toString 转换必须兼容两种形态
        agentWithModel();
        when(teams.findById(1L)).thenReturn(Result.success(null));

        ToolExecuteResult result = tool().execute(execution(Map.of(ExecutionAttributes.TEAM_ID, 1)));

        assertTrue(result.getToolOutput().contains("未找到指定的团队: 1"));
        assertFalse(result.getToolOutput().contains("未确定当前协作团队"));
    }

    @Test
    void missingTeamIdFailsBeforeTeamLookup() {
        ToolExecuteResult result = tool().execute(execution(new HashMap<>()));

        assertTrue(result.getToolOutput().contains("未确定当前协作团队，无法委派任务"));
        verifyNoInteractions(agents, teams);
    }
}

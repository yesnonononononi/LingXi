package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.skill.SkillRootResolver;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationSubmitter;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationTask;
import com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationRecorder;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.AsyncDelegationResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 协作式委派的编排守卫。
 *
 * <p>盯三件事：① 调用<b>立即</b>返回结构化受理 JSON（键集合固定、不含子代理正文、非 PROMISE）；
 * ② 工具线程<b>不跑子 loop</b>（提交给异步体即返回，主理人可继续本轮）；③ 提交失败与登记失败
 * 都必须 fail-closed（不谎报已委派、不产生孤儿）。</p>
 */
class CallSubAgentAsyncDelegationTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long CHILD_AGENT_ID = 7L;
    private static final long TEAM_ID = 3L;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private final AgentService agentService = mock(AgentService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final SubAgent subAgent = mock(SubAgent.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
            mock(com.summit.dp.turn.application.service.ChatTurnService.class);
    private final AsyncDelegationSubmitter asyncSubmitter = mock(AsyncDelegationSubmitter.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);

    private final CallSubAgentTool tool;

    CallSubAgentAsyncDelegationTest() {
        lenient().when(settingsProvider.current()).thenReturn(Optional.empty());
        lenient().when(modelService.runtimeConfig(anyLong(), any())).thenReturn(
                com.summit.core.conf.ModelConfig.builder()
                        .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());
        // 工作目录解析不到已登记工作空间：回落为「无工作空间」，不静默放行也不炸。
        lenient().when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));

        SubAgentRequestFactory requestFactory = new SubAgentRequestFactory(workspaceService, modelService,
                settingsProvider, mock(WorkspaceConverter.class), new SkillRootResolver(""));
        SubSessionResolver subSessionResolver = new SubSessionResolver(sessionRepository, modelContextService);
        DelegationRecorder recorder = new DelegationRecorder(chatTurnService, transcriptService);

        this.tool = new CallSubAgentTool(objectMapper, agentService, teamService, requestFactory,
                subSessionResolver, registry, sessionRepository, asyncSubmitter,
                new AsyncDelegationResultRenderer(objectMapper));
    }

    private AgentVO childAgent() {
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        agent.setModelId(4L);
        agent.setToolList(List.of("read_file"));
        return agent;
    }

    private TeamVO team() {
        return TeamVO.builder().id(TEAM_ID).commanderAgentId(5L).agents(List.of(childAgent())).build();
    }

    private ToolExecution toolExecution(String args) {
        ToolExecution execution = mock(ToolExecution.class);
        lenient().when(execution.getExecutionId()).thenReturn(String.valueOf(ROOT_EXECUTION_ID));
        lenient().when(execution.getId()).thenReturn("call-1");
        lenient().when(execution.getArgs()).thenReturn(args);
        lenient().when(execution.getAttributes()).thenReturn(Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.TEAM_ID, String.valueOf(TEAM_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)));
        lenient().when(execution.getEventMetaData()).thenReturn(Map.of("turnId", "9001"));
        return execution;
    }

    private String args() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agentId", CHILD_AGENT_ID);
        payload.put("task", "复现并定位主流程抖动");
        payload.put("prompt", "上下文");
        payload.put("workDir", "wd-a");
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void stubAgentAndTeam() {
        when(agentService.findById(CHILD_AGENT_ID)).thenReturn(Result.success(childAgent()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(team()));
    }

    @Test
    @DisplayName("协作式：立即返回结构化 JSON（键固定、无正文、非 PROMISE），且工具线程不跑子 loop")
    void asyncDelegationReturnsStructuredJsonImmediately() throws Exception {
        stubAgentAndTeam();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(eq(ROOT_SESSION_ID), anyLong())).thenReturn(true);

        long startedAt = System.currentTimeMillis();
        ToolExecuteResult result = tool.execute(toolExecution(args()));
        long elapsed = System.currentTimeMillis() - startedAt;

        assertTrue(result.isSuccess(), "协作式必须成功返回");
        assertFalse(result.isPromise(), "协作式不得返回 PROMISE，否则父执行会永挂");
        assertTrue(elapsed <= 5_000L, "必须在 5 秒内返回，实际=" + elapsed);

        // 工具线程不跑子 loop：提交给异步体即返回。
        verify(subAgent, never()).execute(any(AgentRequest.class));
        verify(subAgent, never()).execute(any(Execution.class));
        verify(subAgent, never()).createExecution(any(AgentRequest.class));

        // 提交前登记「待启动」，登记成功才提交。
        ArgumentCaptor<AsyncDelegationTask> taskCaptor = ArgumentCaptor.forClass(AsyncDelegationTask.class);
        verify(asyncSubmitter).submit(taskCaptor.capture());
        AsyncDelegationTask task = taskCaptor.getValue();
        assertEquals(ROOT_SESSION_ID, task.rootSessionId());
        assertEquals(ROOT_EXECUTION_ID, task.rootExecutionId(), "根执行 id 由请求线程解析一次带过去（用于兜底唤醒）");
        assertNotNull(task.numericSubSessionId());
        assertNotNull(task.request());
        assertEquals(CHILD_AGENT_ID, task.agent().getId());

        JsonNode json = objectMapper.readTree(result.getToolOutput());
        assertEquals("ASYNC", json.get("runtimeMode").asText());
        assertTrue(json.get("delegated").asBoolean());
        assertTrue(json.get("subSessionId").isTextual(), "subSessionId 必须是字符串（雪花 id 防精度丢失）");
        assertEquals(task.target().subSessionId(), json.get("subSessionId").asText());
        assertEquals(CHILD_AGENT_ID, json.get("agentId").asLong());
        assertEquals("架构师", json.get("agentName").asText());
        assertTrue(json.get("note").asText().contains("核验工作目录中的产物和验证记录"), "受理回执须引导主理人验收产物");
        assertTrue(json.get("note").asText().contains("没有邮件也应自行验收"), "缺邮件不能阻断收口");

        // 键集合固定：多一个键都可能把子代理正文漏给主理人。
        Set<String> keys = new java.util.TreeSet<>();
        json.fieldNames().forEachRemaining(keys::add);
        assertEquals(Set.of("runtimeMode", "delegated", "subSessionId", "agentId", "agentName", "note"),
                keys);
        assertFalse(result.getToolOutput().contains("子代理正文"), "严禁包含子代理正文");
    }

    @Test
    @DisplayName("根已停止：登记失败即返回错误、不提交异步任务（无孤儿）")
    void cancelledRootFailsClosedWithoutSubmit() {
        stubAgentAndTeam();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(eq(ROOT_SESSION_ID), anyLong())).thenReturn(false);

        ToolExecuteResult result = tool.execute(toolExecution(args()));

        assertFalse(result.isSuccess(), "主会话已停止时必须返回错误而不是静默成功");
        assertTrue(result.getToolOutput().contains("主会话已停止"));
        verify(asyncSubmitter, never()).submit(any(AsyncDelegationTask.class));
        verify(subAgent, never()).execute(any(AgentRequest.class));
    }

    @Test
    @DisplayName("提交被拒（线程池拒绝）：撤销登记并 fail-closed，不谎报已委派")
    void rejectedSubmissionRevokesRegistration() {
        stubAgentAndTeam();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(eq(ROOT_SESSION_ID), anyLong())).thenReturn(true);
        org.mockito.Mockito.doThrow(new java.util.concurrent.RejectedExecutionException("qa: rejected"))
                .when(asyncSubmitter).submit(any(AsyncDelegationTask.class));

        ToolExecuteResult result = tool.execute(toolExecution(args()));

        assertFalse(result.isSuccess(), "提交未成功时不得谎报成功（否则模型以为已委派）");
        assertTrue(result.getToolOutput().contains("委派提交失败"));
        ArgumentCaptor<Long> childCaptor = ArgumentCaptor.forClass(Long.class);
        verify(registry).revokeChild(eq(ROOT_SESSION_ID), childCaptor.capture());
        assertNotNull(childCaptor.getValue(), "撤销的是本次登记的子会话");
    }

    @Test
    @DisplayName("请求组装失败即返回错误，且不登记、不提交任何异步任务（不产生孤儿）")
    void assemblyFailureFailsClosed() {
        AgentVO agentWithoutModel = childAgent();
        agentWithoutModel.setModelId(null);
        when(agentService.findById(CHILD_AGENT_ID)).thenReturn(Result.success(agentWithoutModel));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(team()));

        ToolExecuteResult result = tool.execute(toolExecution(args()));

        assertFalse(result.isSuccess(), "缺模型必须失败");
        verify(asyncSubmitter, never()).submit(any(AsyncDelegationTask.class));
        verify(registry, never()).registerPendingChild(any(), any());
        verify(subAgent, never()).execute(any(AgentRequest.class));
    }
}

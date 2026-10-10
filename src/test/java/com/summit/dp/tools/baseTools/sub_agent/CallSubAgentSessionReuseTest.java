package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.skill.SkillRootResolver;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationSubmitter;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationTask;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.AsyncDelegationResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 编排层集成守卫：验证 {@link CallSubAgentTool} 解析子会话（复用 / 派生）并组装请求后的<b>提交载荷</b>。
 *
 * <p>子会话复用判据由 {@code SubSessionResolver} 负责，这里只盯跨协作者的契约：复用命中即把既有
 * 历史交给子执行、未命中即派生新 id 且上下文只有本次任务；其余落库 / 开跑由 {@code AsyncDelegationSubmitter}
 * 承担（另由 {@code AsyncDelegationSubmitterTest} 覆盖）。</p>
 */
class CallSubAgentSessionReuseTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long CHILD_AGENT_ID = 7L;
    private static final long TEAM_ID = 3L;
    private static final long EXISTING_SUB_SESSION_ID = 555L;

    private final AgentService agentService = mock(AgentService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);

    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final AsyncDelegationSubmitter asyncSubmitter = mock(AsyncDelegationSubmitter.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);

    private final CallSubAgentTool tool;

    CallSubAgentSessionReuseTest() {
        lenient().when(settingsProvider.current()).thenReturn(Optional.empty());
        lenient().when(modelService.runtimeConfig(anyLong(), any())).thenReturn(
                com.summit.core.conf.ModelConfig.builder()
                        .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());
        // 未登记的工作目录：请求组装器回落父执行时无父工作空间，解析为「无工作空间」而非失败。
        lenient().when(workspaceService.findByDir(any())).thenReturn(Result.success(null));

        SubSessionResolver subSessionResolver = new SubSessionResolver(sessionRepository, modelContextService);
        SubAgentRequestFactory requestFactory = new SubAgentRequestFactory(workspaceService, modelService,
                settingsProvider, null, new SkillRootResolver(""));
        this.tool = new CallSubAgentTool(new ObjectMapper(), agentService, teamService, requestFactory,
                subSessionResolver, registry, sessionRepository, asyncSubmitter,
                new AsyncDelegationResultRenderer(new ObjectMapper()));
    }

    private ToolExecution toolExecution() {
        ToolExecution execution = mock(ToolExecution.class);
        when(execution.getExecutionId()).thenReturn(String.valueOf(ROOT_EXECUTION_ID));
        when(execution.getTurnId()).thenReturn("turn-1");
        when(execution.getId()).thenReturn("call-1");
        when(execution.getArgs()).thenReturn(
                "{\"agentId\":7,\"task\":\"再评估一下上次的方案\",\"prompt\":\"上下文\",\"workDir\":\"/work\"}");
        when(execution.getAttributes()).thenReturn(Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.TEAM_ID, "3",
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)));
        when(execution.getEventMetaData()).thenReturn(Map.of("turnId", "9001"));
        return execution;
    }

    private AgentVO childAgent() {
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        agent.setModelId(4L);
        agent.setToolList(List.of("read_file"));
        return agent;
    }

    /** 按 agentId 解析出目标 Agent 与团队（真实团队校验在工具内做，这里给出通过条件）。 */
    private void stubDelegation() {
        when(agentService.findById(CHILD_AGENT_ID)).thenReturn(Result.success(childAgent()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(
                TeamVO.builder().id(TEAM_ID).commanderAgentId(5L).agents(List.of(childAgent())).build()));
        when(sessionRepository.findById(ROOT_SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(ROOT_SESSION_ID).build()));
        when(registry.registerPendingChild(anyLong(), anyLong())).thenReturn(true);
    }

    private AsyncDelegationTask captureSubmittedTask() {
        ArgumentCaptor<AsyncDelegationTask> captor = ArgumentCaptor.forClass(AsyncDelegationTask.class);
        verify(asyncSubmitter).submit(captor.capture());
        return captor.getValue();
    }

    @Test
    @DisplayName("命中已有子会话：复用其 id 并把历史交给子执行")
    void reusesExistingSubSessionWithHistory() {
        stubDelegation();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(EXISTING_SUB_SESSION_ID)
                        .rootSessionId(ROOT_SESSION_ID).agentId(CHILD_AGENT_ID)
                        .name("架构师").build()));
        List<Message> prior = new ArrayList<>(List.of(UserMessageEntity.from("上次的任务")));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.of(prior));

        ToolExecuteResult result = tool.execute(toolExecution());

        assertTrue(result.isSuccess(), "复用路径不应失败");
        AsyncDelegationTask task = captureSubmittedTask();
        assertTrue(task.target().reused(), "命中已有子会话必须标记复用");
        assertEquals(EXISTING_SUB_SESSION_ID, task.numericSubSessionId(), "复用同一子会话 id");

        List<Message> delivered = task.request().getMessages();
        assertEquals(2, delivered.size(), "应为「既有历史 + 本次任务」");
        assertTrue(delivered.get(0).text().contains("上次的任务"));
        assertTrue(delivered.get(1).text().contains("再评估一下上次的方案"));
    }

    @Test
    @DisplayName("未命中：派生新子会话，上下文只有本次任务")
    void createsFreshSubSessionWhenNoneExists() {
        stubDelegation();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());

        ToolExecuteResult result = tool.execute(toolExecution());

        assertTrue(result.isSuccess());
        AsyncDelegationTask task = captureSubmittedTask();
        assertFalse(task.target().reused(), "未命中必须标记首派");
        assertNotNull(task.numericSubSessionId());
        assertNotEquals(EXISTING_SUB_SESSION_ID, task.numericSubSessionId(), "未命中时必须派生新 id");
        assertEquals(1, task.request().getMessages().size(), "首派上下文只有本次任务");
    }

    @Test
    @DisplayName("已有子会话但上下文已丢失：复用不失败，绝不回退成派生")
    void degradesToEmptyHistoryWhenContextMissing() {
        stubDelegation();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(EXISTING_SUB_SESSION_ID)
                        .rootSessionId(ROOT_SESSION_ID).agentId(CHILD_AGENT_ID)
                        .name("架构师").build()));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.empty());

        ToolExecuteResult result = tool.execute(toolExecution());

        assertTrue(result.isSuccess());
        AsyncDelegationTask task = captureSubmittedTask();
        assertTrue(task.target().reused(), "上下文缺失也必须复用同一子会话，不得另派生");
        assertEquals(EXISTING_SUB_SESSION_ID, task.numericSubSessionId());
    }

    @Test
    @DisplayName("根会话已停止：不启动子 Agent、不提交（取消校验先于任何可见副作用）")
    void abortsWhenRootCancelled() {
        when(sessionRepository.findById(ROOT_SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(ROOT_SESSION_ID).build()));
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID)).thenReturn(Optional.empty());
        when(registry.registerPendingChild(anyLong(), anyLong())).thenReturn(false);

        ToolExecuteResult result = tool.execute(toolExecution());

        assertFalse(result.isSuccess(), "被取消时必须返回错误而不是静默成功");
        verify(asyncSubmitter, never()).submit(any(AsyncDelegationTask.class));
        verify(sessionRepository, never()).saveAndReturnId(any());
        verify(transcriptService, never()).appendUser(anyLong(), any(), any(), any());
    }
}

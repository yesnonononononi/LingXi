package com.summit.dp.tools.baseTools.sub_agent;

import com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationSuspensionCard;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 编排层集成守卫：验证 {@link CallSubAgentTool} 把三个协作者串起来时的<b>顺序与时机</b>。
 *
 * <p>协作者各自的行为已由 {@code SubSessionResolverTest} / {@code SubAgentRequestFactoryTest}
 * 覆盖，这里只盯跨协作者的契约：复用路径不重复建会话行、两条路径都要发映射事件与追加
 * transcript、取消校验必须先于落库、编排顺序不能倒置。</p>
 */
class CallSubAgentSessionReuseTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_AGENT_ID = 7L;
    private static final long EXISTING_SUB_SESSION_ID = 555L;

    private final SubAgent subAgent = mock(SubAgent.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final com.summit.dp.toolcall.application.service.ToolCallRegistrar registrar =
            mock(com.summit.dp.toolcall.application.service.ToolCallRegistrar.class);
    private final com.summit.dp.execution.ExecutionIdentity executionIdentity =
            mock(com.summit.dp.execution.ExecutionIdentity.class);

    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);

    private final SubSessionResolver subSessionResolver;
    private final CallSubAgentTool tool;

    CallSubAgentSessionReuseTest() {
        lenient().when(settingsProvider.current()).thenReturn(Optional.empty());
        lenient().when(modelService.runtimeConfig(anyLong(), any())).thenReturn(
                com.summit.core.conf.ModelConfig.builder()
                        .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());

        this.subSessionResolver = new SubSessionResolver(sessionRepository, modelContextService);
        SubAgentRequestFactory requestFactory = new SubAgentRequestFactory(null, modelService, settingsProvider, null);
        DelegationSuspensionCard suspensionCard = new DelegationSuspensionCard(registrar,
                new ToolCallConverter(new ObjectMapper()));
        com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationRecorder recorder =
                new com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationRecorder(
                        chatTurnService, transcriptService);
        this.tool = new CallSubAgentTool(new ObjectMapper(), null, null, subAgent,
                requestFactory, subSessionResolver, new SubAgentResultRenderer(),
                registry, modelContextService, sessionRepository,
                suspensionCard, recorder);
    }

    private ToolExecution toolExecution() {
        ToolExecution execution = mock(ToolExecution.class);
        when(execution.getExecutionId()).thenReturn("900");
        when(execution.getTurnId()).thenReturn("turn-1");
        when(execution.getId()).thenReturn("call-1");
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

    private CallSubAgentToolArgument argument() {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setAgentId(CHILD_AGENT_ID);
        argument.setTask("再评估一下上次的方案");
        argument.setPrompt("上下文");
        return argument;
    }

    private Execution completed(String text) {
        Execution execution = mock(Execution.class);
        when(execution.getExecutionState()).thenReturn(ExecutionState.COMPLETED);
        when(execution.getMessages()).thenReturn(List.of(UserMessageEntity.from(text)));
        return execution;
    }

    private void stubRootSession() {
        when(sessionRepository.findById(ROOT_SESSION_ID))
                .thenReturn(Optional.of(Session.builder().id(ROOT_SESSION_ID).build()));
    }

    private ToolExecuteResult invokeExecuteChild(ToolExecution toolExecution, CallSubAgentToolArgument argument) {
        return ReflectionTestUtils.invokeMethod(tool, "executeChild",
                toolExecution, argument, childAgent(),
                TeamVO.builder().id(3L).commanderAgentId(5L).agents(List.of(childAgent())).build(),
                null);
    }

    @Test
    @DisplayName("命中已有子会话：复用其 id、不新建 session 行、把历史交给子 Agent")
    void reusesExistingSubSessionWithoutCreatingAnother() {
        when(chatTurnService.acceptTurn(anyLong(), any(), any(), any(), any(), any())).thenReturn(9002L);
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(EXISTING_SUB_SESSION_ID)
                        .rootSessionId(ROOT_SESSION_ID).agentId(CHILD_AGENT_ID)
                        .name("架构师").build()));

        List<Message> prior = new ArrayList<>(List.of(UserMessageEntity.from("上次的任务")));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.of(prior));

        ArgumentCaptor<AgentRequest> requestCaptor = ArgumentCaptor.forClass(AgentRequest.class);
        Execution done = completed("好的");
        when(subAgent.execute(requestCaptor.capture())).thenReturn(done);

        CallSubAgentToolArgument argument = argument();
        ToolExecuteResult result = invokeExecuteChild(toolExecution(), argument);

        // 1) 复用同 id，且参数回填的是已有子会话
        assertEquals(String.valueOf(EXISTING_SUB_SESSION_ID), argument.getSubSessionId());
        assertTrue(result.isSuccess(), "复用路径不应失败");

        // 2) 绝不重复建 session 行（否则列表出现重复子会话）
        verify(sessionRepository, never()).saveAndReturnId(any());

        // 3) 历史 + 本次任务一并作为执行上下文交给子 Agent
        List<Message> delivered = requestCaptor.getValue().getMessages();
        assertEquals(2, delivered.size(), "应为「既有历史 + 本次任务」");
        assertTrue(delivered.get(0).text().contains("上次的任务"));
        assertTrue(delivered.get(1).text().contains("再评估一下上次的方案"));
        // 子执行继承父的根会话（800）与代际（父元数据缺失代际，回落 1），替换会话/轮次/父轮次。
        assertEquals(Map.of("rootSessionId", String.valueOf(ROOT_SESSION_ID), "sessionId", "555",
                        "turnId", "9002", "parentTurnId", "9001", "historyRevision", "1"),
                requestCaptor.getValue().runtimeParametersOrDefault().getEventMetaData());
        verify(chatTurnService).acceptTurn(eq(EXISTING_SUB_SESSION_ID), eq(ROOT_SESSION_ID), eq(9001L), any(), any(), any());
        verify(chatTurnService, never()).findByExecutionId(any());

        // 4) 子会话身份改由 v3 SESSION_UPDATED + DELEGATION 卡片承载，不再单独发映射事件。
        // 5) 新任务落 transcript
        verify(transcriptService).appendUser(eq(EXISTING_SUB_SESSION_ID), eq(ROOT_SESSION_ID), any(), any());
        // 6) 收尾仍要把上下文快照写回子会话
        verify(modelContextService).replace(eq(EXISTING_SUB_SESSION_ID), any());
    }

    @Test
    @DisplayName("未命中：派生新子会话、建 session 行、上下文只有本次任务")
    void createsNewSubSessionWhenNoneExists() {
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.empty());

        ArgumentCaptor<AgentRequest> requestCaptor = ArgumentCaptor.forClass(AgentRequest.class);
        Execution done = completed("好的");
        when(subAgent.execute(requestCaptor.capture())).thenReturn(done);

        CallSubAgentToolArgument argument = argument();
        invokeExecuteChild(toolExecution(), argument);

        assertNotNull(argument.getSubSessionId());
        assertFalse(String.valueOf(EXISTING_SUB_SESSION_ID).equals(argument.getSubSessionId()),
                "未命中时必须派生新 id");

        // 必须建会话行，且带上 agentId（复用键的来源）
        ArgumentCaptor<Session> sessionCaptor = ArgumentCaptor.forClass(Session.class);
        verify(sessionRepository).saveAndReturnId(sessionCaptor.capture());
        assertEquals(CHILD_AGENT_ID, sessionCaptor.getValue().getAgentId());
        assertEquals(ROOT_SESSION_ID, sessionCaptor.getValue().getRootSessionId());

        assertEquals(1, requestCaptor.getValue().getMessages().size(), "首派上下文只有本次任务");
    }

    @Test
    @DisplayName("已有子会话但上下文已丢失：复用不失败，绝不回退成派生")
    void degradesToEmptyHistoryWhenContextMissing() {
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(EXISTING_SUB_SESSION_ID)
                        .rootSessionId(ROOT_SESSION_ID).agentId(CHILD_AGENT_ID)
                        .name("架构师").build()));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.empty());

        Execution done = completed("好的");
        when(subAgent.execute(any(AgentRequest.class))).thenReturn(done);

        CallSubAgentToolArgument argument = argument();
        ToolExecuteResult result = invokeExecuteChild(toolExecution(), argument);

        assertEquals(String.valueOf(EXISTING_SUB_SESSION_ID), argument.getSubSessionId(),
                "上下文缺失也必须复用同一子会话，不得另派生");
        verify(sessionRepository, never()).saveAndReturnId(any());
        assertTrue(result.isSuccess());
    }

    @Test
    @DisplayName("根会话已停止：不启动子 Agent、不落库、不发事件")
    void abortsWhenRootCancelled() {
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.empty());
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(false);

        ToolExecuteResult result = invokeExecuteChild(toolExecution(), argument());

        assertFalse(result.isSuccess(), "被取消时必须返回错误而不是静默成功");
        verify(subAgent, never()).execute(any(AgentRequest.class));
        verify(sessionRepository, never()).saveAndReturnId(any());
        // 取消校验必须先于落库与事件：被取消的委派不允许留下任何可见痕迹
        verify(transcriptService, never()).appendUser(anyLong(), any(), any(), any());
    }

    @Test
    @DisplayName("执行收尾：成功路径同样解除登记，避免登记表泄漏")
    void unregistersChildOnSuccess() {
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.of(Session.builder().id(EXISTING_SUB_SESSION_ID)
                        .rootSessionId(ROOT_SESSION_ID).agentId(CHILD_AGENT_ID)
                        .name("架构师").build()));
        when(modelContextService.find(EXISTING_SUB_SESSION_ID)).thenReturn(Optional.empty());
        Execution done = completed("好的");
        when(subAgent.execute(any(AgentRequest.class))).thenReturn(done);

        ToolExecuteResult result = invokeExecuteChild(toolExecution(), argument());

        assertTrue(result.isSuccess());
        verify(registry).unregisterChild(ROOT_SESSION_ID, EXISTING_SUB_SESSION_ID);
    }

    @Test
    @DisplayName("结果渲染交由渲染器：返回文本来自子执行的最终答复")
    void resultTextComesFromRenderer() {
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.empty());
        // 先算好桩对象再 when(...)：把 completed() 塞进 thenReturn 参数会触发 UnfinishedStubbing
        Execution done = completed("最终答复：方案是 A");
        when(subAgent.execute(any(AgentRequest.class))).thenReturn(done);

        ToolExecuteResult result = invokeExecuteChild(toolExecution(), argument());

        assertTrue(result.getToolOutput().contains("最终答复：方案是 A"));
    }

    @Test
    @DisplayName("子执行挂起：父执行以 PROMISE 槽位同步挂起，登记 DELEGATION 卡并按根会话推送")
    void suspendsParentWhenChildSuspended() {
        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        stubRootSession();
        when(sessionRepository.findByRootAndAgent(ROOT_SESSION_ID, CHILD_AGENT_ID))
                .thenReturn(Optional.empty());
        when(modelContextService.find(anyLong())).thenReturn(Optional.empty());

        Execution suspended = mock(Execution.class);
        when(suspended.getExecutionState()).thenReturn(ExecutionState.SUSPENDED);
        when(suspended.getMessages()).thenReturn(List.of());
        when(subAgent.execute(any(AgentRequest.class))).thenReturn(suspended);
        when(executionIdentity.resolveRootSessionId(ROOT_SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        ToolExecution execution = toolExecution();
        // ToolDefinition 是 record（final），不能 mock —— 用真实实例，executor 恒不触达
        com.summit.core.tool.ToolDefinition<?> definition = com.summit.core.tool.ToolDefinition.builder()
                .maxOutput(1000).timeout(60L)
                .executor(mock(com.summit.core.tool.ToolExecutor.class))
                .id("call_sub_agent").name("call_sub_agent")
                .build();
        org.mockito.Mockito.doReturn(definition).when(execution).getToolDefinition();

        ToolExecuteResult result = invokeExecuteChild(execution, argument());

        assertTrue(result.isPromise(), "挂起分支必须返回 promise，让父执行同步挂起而非提前收尾");
        ArgumentCaptor<com.summit.dp.toolcall.application.command.ToolCallRegisterCommand> command =
                ArgumentCaptor.forClass(com.summit.dp.toolcall.application.command.ToolCallRegisterCommand.class);
        verify(registrar).registerPromise(command.capture());
        assertEquals(com.summit.dp.toolcall.domain.model.ToolCallKind.DELEGATION, command.getValue().kind());
        assertEquals(String.valueOf(ROOT_SESSION_ID), String.valueOf(command.getValue().conversationId()));
        assertTrue(command.getValue().content().contains("\"subSessionId\""),
                "卡片载荷必须带 subSessionId，供子执行终态回填时匹配槽位");
        // 挂起路径同样要解除登记
        verify(registry).unregisterChild(eq(ROOT_SESSION_ID), anyLong());
    }
}

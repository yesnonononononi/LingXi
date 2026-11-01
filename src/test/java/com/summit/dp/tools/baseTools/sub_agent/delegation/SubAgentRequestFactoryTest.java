package com.summit.dp.tools.baseTools.sub_agent.delegation;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.ArrayList;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.ParameterizedTest;
import com.summit.runtime.model.DefaultChatModelInvoker;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.BoundaryChecker;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.compact.DefaultModelCompacter;
import com.summit.runtime.compact.DefaultContextPruner;
import com.summit.runtime.agent.AgentConfig;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.agent.ExecutionState;
import com.summit.core.agent.Execution;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.RuntimeConfigurationTestSupport;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.workflow.infrastructure.tools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 委派出去的子执行必须拿到「成员版」上下文：
 * <ul>
 *   <li>属性里带 {@code TEAM_ID}（成员也有 {@code send_mail_to_agent}，发信要用团队快照）；</li>
 *   <li>工具清单里有 {@code send_mail_to_agent}，但<b>永远没有</b> {@code call_sub_agent}；</li>
 *   <li>系统提示词里带上与指挥者同一份的团队成员名单；</li>
 *   <li>{@code messages} 是执行期历史唯一来源：复用时要带上既有历史，首派时只有本次任务。</li>
 * </ul>
 */
class SubAgentRequestFactoryTest {

    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);

    /** Skill 关闭（空配置）时的组装器：本类多数用例的基线。 */
    private final SubAgentRequestFactory factory = new SubAgentRequestFactory(
            workspaceService, modelService, settingsProvider, workspaceConverter, new SkillRootResolver(""), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create());

    @TempDir
    Path skillDir;

    /** Skill 开启时的组装器：根目录指向一个真实存在的临时目录。 */
    private SubAgentRequestFactory factoryWithSkills() {
        return new SubAgentRequestFactory(workspaceService, modelService, settingsProvider,
                workspaceConverter, new SkillRootResolver(skillDir.toString()), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create());
    }

    @ParameterizedTest(name = "复用历史={0}")
    @ValueSource(booleans = {false, true})
    void taskStaysInSystemPromptThroughPruningSummaryAndCheckpointResume(boolean reused) throws Exception {
        stubModel();
        AgentVO member = agent(6L, "工程师", "执行主理人交付的任务");
        String oldTask = "上一轮委派：核查旧端口";
        List<Message> prior = reused ? List.of(SystemMessageEntity.builder().text(oldTask).build(),
                UserMessageEntity.from("旧轮用户输入")) : List.of();
        AgentRequest request = build(member, buildTeam(member), parentToolExecution(), prior);
        String task = "请只回复一个词：ok";
        assertEquals(List.of(task), request.getTask());
        Execution execution = Execution.create(request, "");
        execution.setMessages(new ArrayList<>(execution.getMessages()));
        DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
        conversations.startConversation(execution, null, null);
        execution.startChecked();
        String protectedPrompt = execution.getMessages().getFirst().text();
        assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getFirst());
        assertTrue(protectedPrompt.contains(task));
        assertFalse(protectedPrompt.contains(oldTask), "复用子会话不能沿用上一轮的系统任务");

        // 邮件成为最后用户消息后，历史工具组必须真的被剪掉，不能只验证一个未执行的压缩调用。
        conversations.appendMessage(execution, AiMessageEntity.builder().text("历史读取")
                .toolCalls(List.of(new ToolCallRequest("old-read", ToolCatalog.READ_FILE, 0, "{}"))).build());
        conversations.appendMessage(execution, ToolMessageEntity.builder().id("old-read").name(ToolCatalog.READ_FILE)
                .toolOutput("历史工具输出".repeat(2000)).build());
        conversations.appendUserMessage(execution, "协作邮件：上一轮端口纠错，作为补充背景");
        DefaultTokenizer tokenizer = new DefaultTokenizer();
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
        ContextUsageReporter usage = new ContextUsageReporter(tokenizer, 100000, events, 1);
        AgentConfig config = AgentConfig.builder().maxTokens(100000).maxIterations(3).build();
        int before = tokenizer.count(execution.getMessages());
        assertTrue(new DefaultContextPruner(config, usage).compact(new ContextCompactRequest(execution)));
        int pruned = tokenizer.count(execution.getMessages());
        assertTrue(pruned < before, "历史工具内容必须实际缩减");
        assertTrue(execution.getMessages().stream().noneMatch(ToolMessageEntity.class::isInstance));
        assertEquals(protectedPrompt, execution.getMessages().getFirst().text());

        // 摘要故意不复述任务，确认任务保护来自系统段，而不是摘要模型碰巧记住了它。
        AtomicInteger summaries = new AtomicInteger();
        ChatModel summaryModel = command -> {
            summaries.incrementAndGet();
            return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                    .text("{\"summary\":\"历史端口纠错已处理\"}").build()).build();
        };
        DefaultModelCompacter compacter = new DefaultModelCompacter(summaryModel, conversations,
                ContextAttachmentProvider.NONE, usage);
        for (int round = 0; round < 2; round++) {
            assertTrue(compacter.compact(new ContextCompactRequest(execution)));
            assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getFirst());
            assertEquals(protectedPrompt, execution.getMessages().getFirst().text());
            assertTrue(execution.getMessages().getFirst().text().contains(task));
        }
        assertEquals(2, summaries.get());

        execution.suspendChecked();
        ObjectMapper json = new JsonConfig().objectMapper();
        Path checkpoint = skillDir.resolve("delegation-checkpoint.json");
        json.writeValue(checkpoint.toFile(), execution);
        Execution restored = json.readValue(checkpoint.toFile(), Execution.class);
        assertEquals(List.of(task), restored.getAgentRequest().getTask());
        assertEquals(protectedPrompt, restored.getMessages().getFirst().text());

        // 恢复链不会重新初始化系统提示词，验证真正送模时仍使用受保护的任务段。
        List<Message> sent = new ArrayList<>();
        ToolExecutionManager tools = mock(ToolExecutionManager.class);
        when(tools.toolRegistry()).thenReturn(new ToolRegistry(List.of()));
        InMemoryActiveExecutionRegistry snapshots = new InMemoryActiveExecutionRegistry(json);
        DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
        RuntimeProcessorTemplate runtime = new RuntimeProcessorTemplate(RuntimeContext.builder()
                .executionRepository(snapshots).conversationManager(conversations).toolExecutionManager(tools)
                .executionControl(new DefaultExecutionController(() -> null, snapshots, events, lifecycle))
                .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events).usage(usage)
                .runtimeBoundaryChecker(new BoundaryChecker(config, tokenizer, conversations, null, null))
                .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                .invoker(new DefaultChatModelInvoker(command -> {
                    sent.addAll(command.getMessages());
                    return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                            .text("按本次委派继续处理").toolCalls(List.of()).build()).tokenUsage(TokenUsageEntity.empty()).build();
                })).build());
        assertEquals(ExecutionState.COMPLETED, runtime.execute(restored).getExecutionState());
        assertInstanceOf(SystemMessageEntity.class, sent.getFirst());
        assertEquals(protectedPrompt, sent.getFirst().text());
        assertTrue(sent.getFirst().text().contains(task));
        System.out.printf("验证委派任务保护: reused=%s, tokensBefore=%d, tokensAfterPrune=%d, summaries=%d, runtimeJar=%s%n",
                reused, before, pruned, summaries.get(), DefaultConversationManager.class.getProtectionDomain().getCodeSource().getLocation());
    }

    @Test
    void imageCapabilityUsesTheChildModelRatherThanTheParentModel() {
        stubModel();
        SubAgentRequestFactory target = new SubAgentRequestFactory(workspaceService, modelService, settingsProvider,
                workspaceConverter, new SkillRootResolver(""), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create());
        AgentVO member = agent(6L, "图片评审员", "检查图片");
        member.setToolList(List.of(ToolCatalog.READ_FILE));
        ToolExecution parent = ToolExecution.builder().executionId("900")
                .attributes(Map.of(ExecutionAttributes.MODEL_VISION, false)).build();
        when(modelService.resolveRuntimeConfig(anyLong(), any())).thenReturn(new RuntimeModel(ModelConfig.builder().modelName("arbitrary-model").build(), true));
        AgentRequest supported = build(target, member, buildTeam(member), parent, List.of());
        assertNotNull(supported.getModelConfigSpec());
        assertEquals(member.getModelId().longValue(), supported.getModelConfigSpec().getId().longValue());
        assertTrue(supported.getRetryConfig().isEnabled());
        assertTrue(supported.getToolList().contains(ToolCatalog.READ_IMAGE));
        assertEquals(true, supported.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.MODEL_VISION));

        when(modelService.resolveRuntimeConfig(anyLong(), any())).thenReturn(new RuntimeModel(ModelConfig.builder().modelName("claude-opus").build(), false));
        AgentRequest unsupported = build(target, member, buildTeam(member), ToolExecution.builder().executionId("900")
                .attributes(Map.of(ExecutionAttributes.MODEL_VISION, true)).build(), List.of());
        assertFalse(unsupported.getToolList().contains(ToolCatalog.READ_IMAGE));
        assertEquals(false, unsupported.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.MODEL_VISION));
    }

    @Test
    @DisplayName("子执行继承只读档：禁用编辑工具，保留终端")
    void readOnlyChildCannotRegainEditingThroughItsOwnToolConfiguration() {
        stubModel();
        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setToolList(ToolCatalog.DEFAULT_AGENT_TOOLS);
        for (AgentAccessMode mode : List.of(AgentAccessMode.READ_ONLY_IN_WORKSPACE, AgentAccessMode.IN_WORKSPACE)) {
            ToolExecution parent = ToolExecution.builder().executionId("900")
                    .attributes(AgentAccessMode.toAttributes(mode)).build();
            AgentRequest request = build(member, buildTeam(member), parent);
            assertEquals(mode, AgentAccessMode.from(request.runtimeParametersOrDefault().getAttributes()));
            assertEquals(mode.allowsWriteTools(), request.getToolList().contains(ToolCatalog.EDIT_FILE));
            assertTrue(request.getToolList().contains(ToolCatalog.EXECUTE_COMMAND));
            assertTrue(request.getToolList().contains(ToolCatalog.READ_FILE));
        }
    }

    @Test
    @DisplayName("子执行：带 TEAM_ID、带发信工具、不带委派工具，并带上团队成员名单")
    void childRequestCarriesTeamIdAndMailButNeverDelegation() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        AgentVO commander = agent(5L, "产品经理", "你是产品经理");
        TeamVO team = TeamVO.builder().id(3L).name("summit软件开发组").commanderAgentId(5L)
                .agents(List.of(commander, member)).build();
        ToolExecution toolExecution = ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3",
                        ExecutionAttributes.SESSION_ID, "777"))
                .build();

        AgentRequest request = build(member, team, toolExecution);

        // 1) 属性：TEAM_ID 随委派下行，身份链完整
        Map<String, Object> attributes = request.runtimeParametersOrDefault().getAttributes();
        assertEquals("3", attributes.get(ExecutionAttributes.TEAM_ID), "成员要能发信，必须拿到团队快照");
        assertEquals("6", attributes.get(ExecutionAttributes.AGENT_ID));
        assertEquals("1234", attributes.get(ExecutionAttributes.SESSION_ID));
        assertEquals("900", attributes.get(ExecutionAttributes.ROOT_EXECUTION_ID));
        assertEquals("777", attributes.get(ExecutionAttributes.ROOT_SESSION_ID),
                "邮箱业务键是协作根会话 id，子执行必须带上父执行的根会话 id");

        // 2) 工具清单：给发信，绝不给委派
        List<String> tools = request.getToolList();
        assertTrue(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT), "成员要能和队友同步信息");
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT), "委派只发生在指挥者这一层");
        assertTrue(tools.contains("read_file"), "Agent 自身配置的工具保留");

        // 3) 提示词：与指挥者同一份成员名单 + 成员职责话术
        String prompt = request.getSystemPrompt();
        assertTrue(prompt.contains("### 成员名单(TEAM ROSTER)"), "名单标题与指挥者同一份渲染");
        assertTrue(prompt.contains("- id: 5") && prompt.contains("- name: 产品经理")
                        && prompt.contains("- description: 未提供能力描述"),
                "名单用与指挥者相同的多行格式渲染；描述缺失时用统一兜底文案");
        assertFalse(prompt.contains("- id: 6"), "成员名单里不含自己");
        assertFalse(prompt.contains("# 可委派队友"), "成员没有可委派队友");
    }

    @Test
    @DisplayName("父执行没有团队时：不凭空给子执行写 TEAM_ID")
    void childRequestOmitsTeamIdWhenParentHasNone() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        ToolExecution toolExecution = ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5"))
                .build();

        AgentRequest request = build(member, TeamVO.builder().id(3L).commanderAgentId(5L)
                .agents(List.of(member)).build(), toolExecution);

        assertNull(request.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.TEAM_ID));
        assertNull(request.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.ROOT_SESSION_ID),
                "父执行没有根会话归属时不凭空写邮箱键");
    }

    @Test
    @DisplayName("成员没配工具清单：至少给发信能力，不再是一个工具都没有")
    void unconfiguredMemberStillGetsMail() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setToolList(null);

        AgentRequest request = build(member, TeamVO.builder().id(3L).commanderAgentId(5L)
                .agents(List.of(member)).build(), ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build());

        assertEquals(List.of(ToolCatalog.SEND_MAIL_TO_AGENT), request.getToolList());
    }

    @Test
    @DisplayName("首派：messages 只有本次任务，不带任何历史")
    void freshDelegationCarriesOnlyCurrentTask() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        AgentRequest request = build(member, buildTeam(member), parentToolExecution(), List.of());

        List<Message> messages = request.getMessages();
        assertEquals(1, messages.size());
        assertTrue(messages.getFirst().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("复用：messages 为「既有历史 + 本次任务」，且本次任务在末位")
    void reusedDelegationAppendsTaskAfterHistory() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        List<Message> prior = List.of(
                UserMessageEntity.from("上次的任务"),
                UserMessageEntity.from("上次的追问"));

        AgentRequest request = build(member, buildTeam(member), parentToolExecution(), prior);

        List<Message> messages = request.getMessages();
        assertEquals(3, messages.size(), "历史两条 + 本次任务一条");
        assertTrue(messages.get(0).text().contains("上次的任务"));
        assertTrue(messages.get(1).text().contains("上次的追问"));
        assertTrue(messages.getLast().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("子 Agent 未绑定模型：直接报错，不静默继承父任务模型")
    void missingModelFailsFast() {
        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setModelId(null);

        org.junit.jupiter.api.Assertions.assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> build(member, buildTeam(member), parentToolExecution(), List.of()));
    }

    @Test
    @DisplayName("Skill 根目录可用：子执行拿到 read_skill 与请求级 skillConfig；关闭时两者都不给")
    void childRequestCarriesSkillRootOnlyWhenConfigured() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        TeamVO team = buildTeam(member);

        // 开启：框架按请求级 skillConfig 渲染 Skill 提示词，正文只能靠 read_skill 取回 ——
        // 名单即授权，不补工具就等于提示词里说了件模型做不到的事。
        AgentRequest withSkills = build(factoryWithSkills(), member, team, parentToolExecution(), List.of());
        assertTrue(withSkills.getToolList().contains(ToolCatalog.READ_SKILL),
                "Skill 可用时必须下发 read_skill，否则子执行看得到入口路径却读不了");
        assertNotNull(withSkills.getSkillConfig(), "必须下发 skillConfig，否则框架不会渲染 Skill 提示词");
        assertEquals(skillDir.toAbsolutePath().normalize(), withSkills.getSkillConfig().getPath(),
                "skillConfig 必须指向配置的根目录（read_skill 也按它做越界校验）");

        // 关闭：目录不可用时不下发，避免框架把「配了目录却不存在」判为错误
        AgentRequest withoutSkills = build(member, team, parentToolExecution(), List.of());
        assertFalse(withoutSkills.getToolList().contains(ToolCatalog.READ_SKILL));
        assertNull(withoutSkills.getSkillConfig());
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution) {
        return build(member, team, toolExecution, List.of());
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution, List<Message> priorMessages) {
        return build(factory, member, team, toolExecution, priorMessages);
    }

    private AgentRequest build(SubAgentRequestFactory target, AgentVO member, TeamVO team,
                               ToolExecution toolExecution, List<Message> priorMessages) {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setAgentId(member.getId());
        argument.setTask("请只回复一个词：ok");
        argument.setPrompt("这是委派上下文");
        return target.build(argument, member, team, toolExecution, null, "1234", null, priorMessages);
    }

    private static TeamVO buildTeam(AgentVO member) {
        return TeamVO.builder().id(3L).commanderAgentId(5L).agents(List.of(member)).build();
    }

    private static ToolExecution parentToolExecution() {
        return ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build();
    }

    private void stubModel() {
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(modelService.resolveRuntimeConfig(anyLong(), any())).thenReturn(new RuntimeModel(ModelConfig.builder()
                .baseUrl("https://example.invalid").apiKey("k").modelName("m").build(), false));
        when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));
    }

    private static AgentVO agent(Long id, String name, String prompt) {
        AgentVO agent = new AgentVO();
        agent.setId(id);
        agent.setName(name);
        agent.setPrompt(prompt);
        agent.setModelId(4L);
        agent.setToolList(List.of("read_file", ToolCatalog.CALL_SUB_AGENT, "execute_command"));
        return agent;
    }
}

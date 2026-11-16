package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.*;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.*;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.RuntimeConfigurationTestSupport;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workflow.application.decision.CommandApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.policy.CommandPolicyConfig;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.workflow.infrastructure.tools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.compact.DefaultCompactSummaryApplier;
import com.summit.runtime.compact.DefaultContextPruner;
import com.summit.runtime.compact.DefaultModelCompacter;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.*;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

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

    /** 本次委派的任务正文：多数用例共用一个极短任务，断言好定位。 */
    private static final String TASK = "请只回复一个词：ok";

    /** 基线委派上下文：与 TASK 一样只是夹具，守卫用例会显式传入不同内容。 */
    private static final String CALLER_PROMPT = "这是委派上下文";

    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);

    /** Skill 关闭（空配置）时的组装器：本类多数用例的基线。 */
    private final SubAgentRequestFactory factory = new SubAgentRequestFactory(
            workspaceService, modelService, settingsProvider, workspaceConverter, new SkillRootResolver(""), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create(), List.of());

    @TempDir
    Path skillDir;

    /** Skill 开启时的组装器：根目录指向一个真实存在的临时目录。 */
    private SubAgentRequestFactory factoryWithSkills() {
        return new SubAgentRequestFactory(workspaceService, modelService, settingsProvider,
                workspaceConverter, new SkillRootResolver(skillDir.toString()), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create(), List.of());
    }

    @ParameterizedTest
    @EnumSource(AgentPermissionMode.class)
    void childInheritsApprovalFromParentSnapshotEvenWhenSettingsDiffer(AgentPermissionMode mode) throws Exception {
        stubModel();
        SettingsView current = mock(SettingsView.class);
        when(current.permissionMode()).thenReturn(mode == AgentPermissionMode.FULL_ACCESS
                ? AgentPermissionMode.APPROVAL_REQUIRED : AgentPermissionMode.FULL_ACCESS);
        when(settingsProvider.current()).thenReturn(Optional.of(current));
        AgentVO member = agent(6L, "工程师", "执行委派任务");
        ToolExecution parent = ToolExecution.builder().executionId("900")
                .attributes(Map.of(AgentPermissionMode.ATTRIBUTE_KEY, mode.name(),
                        "unrelated.parent.attribute", "不应下行")).build();
        ObjectMapper json = new JsonConfig().objectMapper();
        for (boolean reused : List.of(false, true)) {
            List<Message> prior = reused ? List.of(UserMessageEntity.from("旧任务")) : List.of();
            AgentRequest request = build(member, buildTeam(member), parent, prior);
            Map<String, Object> attributes = request.runtimeParametersOrDefault().getAttributes();
            assertEquals(mode.name(), attributes.get(AgentPermissionMode.ATTRIBUTE_KEY));
            assertFalse(attributes.containsKey("unrelated.parent.attribute"));

            Execution restored = json.readValue(json.writeValueAsString(Execution.create(request, "")), Execution.class);
            assertEquals(mode.name(), restored.getAgentRequest().runtimeParametersOrDefault().getAttributes()
                    .get(AgentPermissionMode.ATTRIBUTE_KEY));
        }
    }

    @Test
    void childWithoutParentApprovalPolicyCarriesTheDefaultExplicitly() {
        stubModel();
        AgentVO member = agent(6L, "工程师", "执行委派任务");
        AgentRequest request = build(member, buildTeam(member), parentToolExecution());
        assertEquals(AgentPermissionMode.DEFAULT.name(), request.runtimeParametersOrDefault().getAttributes()
                .get(AgentPermissionMode.ATTRIBUTE_KEY));
    }

    @Test
    void fullAccessDelegationPassesTheReportedCleanupCommandWithoutApproval() throws Exception {
        stubModel();
        AgentVO member = agent(6L, "工程师", "执行委派任务");
        ToolExecution parent = ToolExecution.builder().executionId("900")
                .attributes(AgentPermissionMode.toAttributes(AgentPermissionMode.FULL_ACCESS)).build();
        AgentRequest child = build(member, buildTeam(member), parent);
        ObjectMapper json = new ObjectMapper();
        CommandApprovalRegistrar approvals = mock(CommandApprovalRegistrar.class);
        ToolExecutionPolicy policy = new CommandPolicyConfig().commandApprovalPolicy(json, approvals);
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder()
                .osType(OsType.WINDOWS).shellType(ShellType.CMD).build());
        ToolDefinition<?> definition = ToolDefinition.<CommandToolDefinitionExecutor>builder()
                .id(ToolCatalog.EXECUTE_COMMAND).name(ToolCatalog.EXECUTE_COMMAND)
                .maxOutput(1000).timeout(30L)
                .executor(new CommandToolDefinitionExecutor(json)).build();
        String cleanup = """
                cd /d D:\\Code\\LingXi && del /q .lingxi\\tmp\\manifest1.log .lingxi\\tmp\\manifest2.log .lingxi\\tmp\\testpet7.log 2>nul & echo CLEANED & echo === & git status --porcelain -uall & echo "(空=干净)" & echo === & git log --oneline -4 & echo === & powershell -NoProfile -Command "'pet-orphan 现存数 = ' + @(Get-ChildItem $env:TEMP -Directory -Filter 'pet-orphan-*' -ErrorAction SilentlyContinue).Count"
                """;
        for (String command : List.of(cleanup, "wsl --shutdown", "Clear-Disk -Number 99")) {
            ToolExecution execution = ToolExecution.builder().executionId("901").id("child-command")
                    .toolDefinition(definition).workspace(workspace)
                    .attributes(child.runtimeParametersOrDefault().getAttributes())
                    .args(json.writeValueAsString(Map.of("command", command))).build();
            assertNull(policy.beforeExecution(execution), command);
        }
        verifyNoInteractions(approvals);
    }

    @ParameterizedTest(name = "复用历史={0}")
    @ValueSource(booleans = {false, true})
    void taskArrivesAsTheTrailingUserMessageAndThePrefixStaysUntouched(boolean reused) throws Exception {
        stubModel();
        AgentVO member = agent(6L, "工程师", "执行主理人交付的任务");
        // 复用会话的历史是同一个子 Agent 自己的前缀：开头那条系统消息必须原样留着，
        // 它是缓存前缀与 thinking 签名绑定的起点，改写它等于让复用每轮重新计费。
        String previousPrompt = "上一轮的系统提示词：核查旧端口";
        List<Message> prior = reused ? List.of(SystemMessageEntity.builder().text(previousPrompt).build(),
                UserMessageEntity.from("旧轮用户输入"),
                AiMessageEntity.builder().text("旧轮回复").build()) : List.of();
        AgentRequest request = build(member, buildTeam(member), parentToolExecution(), prior);
        String task = "请只回复一个词：ok";
        assertNull(request.getTask(), "任务不再挂在请求上：它是一条用户消息");
        String trailing = request.getContextSpec().getContext().getLast().text();
        assertTrue(trailing.startsWith(task), "本次任务追加在历史末尾，历史一个字节都不改: " + trailing);
        assertTrue(trailing.contains(CALLER_PROMPT), "主理人给的上下文必须随任务一起送达: " + trailing);
        assertFalse(request.getContextSpec().getSystemPrompt().contains(CALLER_PROMPT),
                "委派上下文不进系统提示词: " + request.getContextSpec().getSystemPrompt());
        if (reused) {
            assertEquals(previousPrompt, request.getContextSpec().getContext().getFirst().text(),
                    "复用会话的前缀原样交回框架，缓存才可能命中");
        }

        Execution execution = Execution.create(request, "");
        execution.setMessages(new ArrayList<>(execution.getMessages()));
        DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
        conversations.startConversation(execution, null, null);
        execution.startChecked();
        String protectedPrompt = execution.getMessages().getFirst().text();
        assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getFirst());
        assertTrue(carries(execution.getMessages(), task), "本次委派任务必须以用户消息送达");
        if (reused) {
            assertEquals(previousPrompt, protectedPrompt, "复用会话的前缀由历史提供，框架既不添加也不替换");
        }

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

        AtomicInteger summaries = new AtomicInteger();
        ChatModel summaryModel = command -> {
            summaries.incrementAndGet();
            return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                    .text("{\"summary\":\"历史端口纠错已处理\"}").build()).build();
        };
        DefaultModelCompacter compacter = DefaultModelCompacter.builder()
                .models(req -> summaryModel)
                .conversationManager(conversations)
                .contextAttachmentProvider(ContextAttachmentProvider.NONE)
                .usage(usage)
                .summaryApplier(new DefaultCompactSummaryApplier(conversations))
                .build();
        for (int round = 0; round < 2; round++) {
            assertTrue(compacter.compact(new ContextCompactRequest(execution)));
            assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getFirst());
            assertEquals(protectedPrompt, execution.getMessages().getFirst().text(),
                    "压缩重建也必须把原来的前缀放回首位");
            assertNull(execution.getAgentRequest().getTask(), "请求上本来就没有任务，压缩也无从丢它");
        }
        assertEquals(2, summaries.get());

        execution.suspendChecked();
        ObjectMapper json = new JsonConfig().objectMapper();
        Path checkpoint = skillDir.resolve("delegation-checkpoint.json");
        json.writeValue(checkpoint.toFile(), execution);
        Execution restored = json.readValue(checkpoint.toFile(), Execution.class);
        assertNull(restored.getAgentRequest().getTask());
        assertEquals(protectedPrompt, restored.getMessages().getFirst().text());

        // 恢复链不会重新初始化系统提示词：前缀照旧，任务本来就在历史里。
        List<Message> sent = new ArrayList<>();
        ToolExecutionManager tools = mock(ToolExecutionManager.class);
        when(tools.toolRegistry()).thenReturn(new ToolRegistry(List.of()));
        InMemoryActiveExecutionRegistry snapshots = new InMemoryActiveExecutionRegistry(json);
        DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
        RuntimeProcessorTemplate runtime = new RuntimeProcessorTemplate(RuntimeContext.builder()
                .executionRepository(snapshots).conversationManager(conversations).toolExecutionManager(tools)
                .executionControl(new DefaultExecutionController(() -> null, snapshots, events, lifecycle))
                .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events).usage(usage)
                // 框架升级：BoundaryChecker 需显式注入 ContextUsageReporter/ToolRegistry（null 会空指针）。
                .runtimeBoundaryChecker(new BoundaryChecker(config, tokenizer, conversations, null, null,
                        usage, tools.toolRegistry()))
                .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                .invoker(new DefaultChatModelInvoker(command -> {
                    sent.addAll(command.getMessages());
                    return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                            .text("按本次委派继续处理").toolCalls(List.of()).build()).tokenUsage(TokenUsageEntity.empty()).build();
                })).build());
        assertEquals(ExecutionState.COMPLETED, runtime.execute(restored).getExecutionState());
        assertInstanceOf(SystemMessageEntity.class, sent.getFirst());
        assertEquals(protectedPrompt, sent.getFirst().text());
    }

    @Test
    void imageCapabilityUsesTheChildModelRatherThanTheParentModel() {
        stubModel();
        SubAgentRequestFactory target = new SubAgentRequestFactory(workspaceService, modelService, settingsProvider,
                workspaceConverter, new SkillRootResolver(""), new BusinessSystemPromptBuilder(""), ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create(), List.of());
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
    @DisplayName("子执行继承只读审阅档：禁用编辑工具与终端工具")
    void readOnlyChildCannotRegainEditingThroughItsOwnToolConfiguration() {
        stubModel();
        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setToolList(ToolCatalog.DEFAULT_AGENT_TOOLS);
        for (AgentPermissionMode mode : List.of(AgentPermissionMode.READ_ONLY_REVIEW, AgentPermissionMode.APPROVAL_REQUIRED)) {
            ToolExecution parent = ToolExecution.builder().executionId("900")
                    .attributes(AgentPermissionMode.toAttributes(mode)).build();
            AgentRequest request = build(member, buildTeam(member), parent);
            assertEquals(mode, AgentPermissionMode.from(request.runtimeParametersOrDefault().getAttributes()));
            assertEquals(mode.allowsWriteTools(), request.getToolList().contains(ToolCatalog.EDIT_FILE));
            assertEquals(mode.allowsTerminalTools(), request.getToolList().contains(ToolCatalog.EXECUTE_COMMAND));
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
        String prompt = request.getContextSpec().getSystemPrompt();
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

        List<Message> messages = request.getContextSpec().getContext();
        assertEquals(1, messages.size());
        assertTrue(messages.getFirst().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("复用：messages 为「既有历史原样 + 本次任务」，且本次任务在末位")
    void reusedDelegationAppendsTaskAfterHistory() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        List<Message> prior = List.of(
                SystemMessageEntity.builder().text("上一轮的系统提示词").build(),
                UserMessageEntity.from("上次的任务"),
                UserMessageEntity.from("上次的追问"));

        AgentRequest request = build(member, buildTeam(member), parentToolExecution(), prior);

        List<Message> messages = request.getContextSpec().getContext();
        assertEquals(4, messages.size(), "历史三条 + 本次任务一条");
        assertEquals("上一轮的系统提示词", messages.getFirst().text(),
                "历史原样保留：剥掉开头的系统消息就等于让缓存前缀与 thinking 签名一起失效");
        assertTrue(messages.get(1).text().contains("上次的任务"));
        assertTrue(messages.get(2).text().contains("上次的追问"));
        assertTrue(messages.getLast().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("守卫：系统提示词不随委派上下文变化，同一成员两次不同 prompt 必须逐字相同")
    void systemPromptIgnoresThePerDelegationCallerPrompt() {
        stubModel();
        AgentVO member = agent(6L, "架构师", "你是架构师");
        TeamVO team = buildTeam(member);

        String first = buildWithCallerPrompt(factory, member, team, parentToolExecution(), List.of(),
                "只改单测，不改主代码").getContextSpec().getSystemPrompt();
        String second = buildWithCallerPrompt(factory, member, team, parentToolExecution(), List.of(),
                "这次换个完全不同的约束").getContextSpec().getSystemPrompt();

        assertFalse(first.contains("只改单测"), "每次委派都变的内容不能进系统提示词: " + first);
        assertEquals(first, second, "系统提示词逐字相同，前缀缓存与复用子会话才不被它带走");
    }

    @Test
    @DisplayName("守卫：复用会话的本次上下文进尾条用户消息，旧前缀逐字不动")
    void reusedDelegationDeliversTheCallerPromptInTheTrailingUserMessage() {
        stubModel();
        AgentVO member = agent(6L, "架构师", "你是架构师");
        String previousPrompt = "上一轮的系统提示词";
        List<Message> prior = List.of(
                SystemMessageEntity.builder().text(previousPrompt).build(),
                UserMessageEntity.from("上次的任务"),
                AiMessageEntity.builder().text("上次的回复").build());

        AgentRequest request = buildWithCallerPrompt(factory, member, buildTeam(member), parentToolExecution(),
                prior, "只改单测，不改主代码");

        List<Message> messages = request.getContextSpec().getContext();
        assertEquals(4, messages.size(), "历史三条 + 本次任务一条");
        assertEquals(previousPrompt, messages.getFirst().text(),
                "旧系统消息必须逐字保留，否则缓存前缀与 thinking 签名一起失效");
        assertInstanceOf(UserMessageEntity.class, messages.getLast());
        assertTrue(messages.getLast().text().contains("只改单测，不改主代码"),
                "复用会话的系统提示词是旧的，本次约束只有这一条路能到成员手里: " + messages.getLast().text());
        assertFalse(request.getContextSpec().getSystemPrompt().contains("只改单测"));
    }

    @Test
    @DisplayName("守卫：首派也只有一条用户消息，任务在前、上下文在约束段，空上下文不留空段")
    void freshDelegationCarriesTaskAndCallerPromptInOneUserMessage() {
        stubModel();
        AgentVO member = agent(6L, "架构师", "你是架构师");
        TeamVO team = buildTeam(member);

        AgentRequest request = buildWithCallerPrompt(factory, member, team, parentToolExecution(), List.of(),
                "  只改单测  ");

        List<Message> messages = request.getContextSpec().getContext();
        assertEquals(1, messages.size());
        String text = messages.getFirst().text();
        assertTrue(text.startsWith(TASK), text);
        assertTrue(text.contains("# 任务上下文与约束\n只改单测"), "上下文必须去空白后整段跟上: " + text);

        AgentRequest withoutContext = buildWithCallerPrompt(factory, member, team, parentToolExecution(),
                List.of(), "   ");
        assertEquals(TASK, withoutContext.getContextSpec().getContext().getFirst().text(),
                "没有上下文时不留空标题，也不给正文加分隔符");
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
    @DisplayName("Skill 根目录可用：子执行下发请求级 skillConfig；read_skill 由框架提供，不进名单")
    void childRequestCarriesSkillRootOnlyWhenConfigured() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        TeamVO team = buildTeam(member);

        // read_skill 是框架内核工具，默认注册且恒准入：业务侧只负责把 skillConfig 交出去。
        AgentRequest withSkills = build(factoryWithSkills(), member, team, parentToolExecution(), List.of());
        assertFalse(withSkills.getToolList().contains(ToolCatalog.READ_SKILL),
                "内核工具不进名单：框架默认注册，业务侧多写一遍只会在改名时漂移");
        assertNotNull(withSkills.getSkillConfig(), "必须下发 skillConfig，否则框架不会渲染 Skill 提示词");
        assertEquals(skillDir.toAbsolutePath().normalize(), withSkills.getSkillConfig().getPath(),
                "skillConfig 必须指向配置的根目录（read_skill 也按它做越界校验）");

        // 关闭：目录不可用时不下发，避免框架把「配了目录却不存在」判为错误
        AgentRequest withoutSkills = build(member, team, parentToolExecution(), List.of());
        assertFalse(withoutSkills.getToolList().contains(ToolCatalog.READ_SKILL));
        assertNull(withoutSkills.getSkillConfig());
    }

    @Test
    @DisplayName("子执行与根会话同一口径：MemoryLoader 的正文一并进入 ContextSpec.memory")
    void childRequestCarriesTheSameMemoryBodies() {
        stubModel();
        AgentVO member = agent(6L, "工程师", "执行委派任务");
        SubAgentRequestFactory withMemory = new SubAgentRequestFactory(workspaceService, modelService, settingsProvider,
                workspaceConverter, new SkillRootResolver(""), new BusinessSystemPromptBuilder(""),
                ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create(),
                List.of(workspace -> List.of("公约正文"), workspace -> List.of()));

        AgentRequest request = build(withMemory, member, buildTeam(member), parentToolExecution(), List.of());

        assertEquals(List.of("公约正文"), request.getContextSpec().getMemory());
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution) {
        return build(member, team, toolExecution, List.of());
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution, List<Message> priorMessages) {
        return build(factory, member, team, toolExecution, priorMessages);
    }

    private AgentRequest build(SubAgentRequestFactory target, AgentVO member, TeamVO team,
                               ToolExecution toolExecution, List<Message> priorMessages) {
        return buildWithCallerPrompt(target, member, team, toolExecution, priorMessages, CALLER_PROMPT);
    }

    /** 委派上下文随参数走：守卫用例要拿不同 prompt 组装两次，不能只靠固定夹具。 */
    private AgentRequest buildWithCallerPrompt(SubAgentRequestFactory target, AgentVO member, TeamVO team,
                                               ToolExecution toolExecution, List<Message> priorMessages,
                                               String callerPrompt) {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setAgentId(member.getId());
        argument.setTask(TASK);
        argument.setPrompt(callerPrompt);
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

    /** 任务段在框架里以每轮动态上下文的消息形态送达，位置不固定在系统提示词。 */
    private static boolean carries(List<Message> messages, String text) {
        return messages.stream().anyMatch(message -> message != null && message.text() != null
                && message.text().contains(text));
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

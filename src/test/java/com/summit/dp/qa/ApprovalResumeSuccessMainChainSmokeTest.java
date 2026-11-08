package com.summit.dp.qa;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.ContextSpec;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.workflow.application.decision.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.decision.VersionedDecisionContract;
import com.summit.dp.workflow.application.decision.CommandApprovalExecutor;
import com.summit.dp.workflow.application.decision.VersionedToolCallDecisionService;
import com.summit.dp.workflow.application.lifecycle.CoordinatorResumeAcceptance;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.BoundaryChecker;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 真实成功主链端到端 smoke：<b>chat 提问 → 工具审批 → 恢复 → 终态成功</b>。
 *
 * <p><b>为什么需要它</b>：既有端到端用例覆盖的是「审批被拒 / 启动失败 / 恢复被取消」这些
 * 异常收口路径，以及装配层的「bean 能解析」；没有任何一条用例证明<b>正常成功</b>这条链真的能走通。
 * 缺了它，「恢复受理被删掉」这类缺陷只会表现为「界面一直转圈」，测试全绿也发现不了。</p>
 *
 * <p><b>真实性</b>：真实 H2 + 真实 Mapper + 真实 {@link LocalExecutionRepository} 检查点 +
 * 真实 {@link InteractionDecisionEngine} + 真实 {@link ExecutionResumeCoordinator} +
 * 框架 {@link RuntimeProcessorTemplate} 真实循环。唯一受控的是模型输出（确定性两轮），
 * 拒答、审批、恢复、终态都由生产代码自己产生。</p>
 *
 * <p><b>必须能被变异弄红</b>：删掉恢复受理（或让恢复派发不跑），执行会停在 SUSPENDED，
 * 本用例的终态成功断言即失败。</p>
 */
class ApprovalResumeSuccessMainChainSmokeTest {

    private static final long CONVERSATION_ID = 7301L;
    private static final long EXECUTION_ID = 7401L;
    private static final String EXECUTION_ID_TEXT = String.valueOf(EXECUTION_ID);
    private static final String TOOL_CALL_ID = "call-plan-smoke";
    private static final String PLAN_TOOL = "create_plan";
    private static final String QUESTION = "帮我把这次重构拆成可执行的步骤";

    private H2TestDatabase database;
    private SqlSessionTemplate session;
    private ObjectMapper mapper;
    private TransactionTemplate transactions;
    private ToolCallRepositoryImpl tools;
    private LocalExecutionRepository executions;
    private ModelContextService contexts;
    private InteractionDecisionEngine engine;
    private VersionedToolCallDecisionService versionedService;
    private ExecutionResumeCoordinator coordinator;
    private RuntimeProcessorTemplate runtime;
    private final AtomicInteger modelCalls = new AtomicInteger();
    private final List<List<Message>> seenRequests = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("approval-resume-success-smoke");
        mapper = new ObjectMapper().findAndRegisterModules();
        session = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class, ToolCallMapper.class,
                SessionContextMapper.class, SessionMessageMapper.class, SessionMapper.class,
                ExecutionResumeTaskMapper.class));
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));

        tools = new ToolCallRepositoryImpl(session.getMapper(ToolCallMapper.class), mapper,
                mock(CardAvailabilityPolicy.class));
        executions = ExecutionRepositoryTestFactory.create(session.getMapper(ExecutionMapper.class), mapper);
        contexts = new ModelContextService(mapper,
                new SessionContextRepositoryImpl(session.getMapper(SessionContextMapper.class)));

        ExecutionControl executionControl = executionControl();
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(
                new SessionAttributeRestorer(mock(SessionRepository.class)), contexts,
                ExecutionRepositoryTestFactory.provider(executionControl));
        ExecutionRepositoryImpl resumeExecutions =
                new ExecutionRepositoryImpl(session.getMapper(ExecutionMapper.class));
        coordinator = new ExecutionResumeCoordinator(
                new ExecutionResumeTaskRepositoryImpl(session.getMapper(ExecutionResumeTaskMapper.class)),
                resumeExecutions, resumer, executionControl,
                new SuspensionGateChain(List.of(new UserPauseSuspensionGate(),
                        new UnresolvedToolSuspensionGate(tools),
                        new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                                mock(SessionRepository.class), resumeExecutions)))),
                new UnresolvedToolSuspensionGate(tools),
                ExecutionRepositoryTestFactory.provider(executions),
                ExecutionRepositoryTestFactory.provider(mock(ExecutionActivity.class)),
                new StartupFailureCloser(executionControl));

        ToolCallConverter converter = new ToolCallConverter(mapper);
        ImmediateSlotResolutionStrategy immediate = new ImmediateSlotResolutionStrategy(converter,
                new ChoiceAnswersValidator(mapper, new SessionMessageRepositoryImpl(
                        session.getMapper(SessionMessageMapper.class), session.getMapper(SessionMapper.class))), tools);
        TwoPhaseCommandResolutionStrategy commandStrategy = new TwoPhaseCommandResolutionStrategy(
                mock(CommandApprovalExecutor.class), tools, converter);
        engine = new InteractionDecisionEngine(tools, converter,
                ExecutionRepositoryTestFactory.provider(executions), contexts, transactions,
                new CoordinatorResumeAcceptance(coordinator),
                new UnresolvedToolSuspensionGate(tools), immediate, commandStrategy);
        versionedService = new VersionedToolCallDecisionService(tools, converter, engine,
                new VersionedDecisionContract(converter));
        runtime = runtime(executionControl);
    }

    @AfterEach
    void close() {
        if (coordinator != null) {
            coordinator.close();
        }
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("真实主链：提问挂起等待计划审批 → 批准 → 恢复跑完 → 执行终态 COMPLETED")
    void approvalResumeEndsInSuccess() throws Exception {
        Execution suspended = runtime.execute(newExecution());

        // 第一段：模型要求建计划 → 框架因 promise 结果挂起，等待人工审批。
        assertEquals(ExecutionState.SUSPENDED, suspended.getExecutionState(),
                "计划工具返回 promise 时执行必须挂起等待审批");
        assertEquals(1, modelCalls.get(), "挂起前只应发生一次模型调用");
        registerPlanCard();

        // 第二段：经生产决策入口批准（真实引擎 + 真实事务 + 真实恢复受理）。
        ToolCallDecisionReceipt receipt = versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_ID, TOOL_CALL_ID,
                "cmd-smoke-approve", 1L, ToolCallAction.APPROVE, "按这个计划执行"));

        assertTrue(receipt.decisionApplied(), "首次批准必须真的落库");
        ToolCall card = tools.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus(), "审批后卡片必须完成");
        assertTrue(card.getRawOutput().contains("APPROVED"), card.getRawOutput());
        assertEquals(1L, resumeRows(), "批准必须登记一条 APPROVAL_DECISION 恢复请求");

        // 第三段：恢复真的跑完了循环，执行到终态成功。
        Execution completed = awaitTerminal();
        assertEquals(ExecutionState.COMPLETED, completed.getExecutionState(), "恢复后必须终态成功");
        assertEquals(2, modelCalls.get(), "恢复后模型只再被调用一次");
        assertTrue(slotOutput(completed, TOOL_CALL_ID).contains("按这个计划执行"),
                "模型必须看到用户批准时写的正文，实际: " + slotOutput(completed, TOOL_CALL_ID));
        assertTrue(lastUserText(seenRequests.get(1)).contains(QUESTION),
                "恢复后的模型调用仍必须带着原始提问");
        assertEquals("SUCCEEDED", awaitResumeState(), "恢复请求行必须以成功收尾");
    }

    /** 真实恢复控制：resume 走框架模板再跑一遍循环，与生产同一条路径。 */
    private ExecutionControl executionControl() {
        ExecutionControl control = mock(ExecutionControl.class);
        when(control.resume(any(Execution.class))).thenAnswer(invocation -> {
            Execution execution = invocation.getArgument(0);
            return runtime.execute(execution);
        });
        doAnswer(invocation -> {
            Execution execution = invocation.getArgument(0);
            execution.resumeChecked();
            executions.save(execution);
            return null;
        }).when(control).beginApproval(any(Execution.class));
        return control;
    }

    /** 真实框架循环：模型第一轮要求建计划，第二轮给出收尾答复。 */
    private RuntimeProcessorTemplate runtime(ExecutionControl control) {
        ToolExecutionManager tools = toolManager();
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
        DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
        DefaultTokenizer tokenizer = new DefaultTokenizer();
        DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
        return new RuntimeProcessorTemplate(RuntimeContext.builder()
                .executionRepository(executions)
                .conversationManager(conversations)
                .executionControl(control)
                .runtimeLifeStyleManager(lifecycle)
                .runtimeEventPublisher(events)
                .toolExecutionManager(tools)
                .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                .runtimeBoundaryChecker(new BoundaryChecker(AgentConfig.builder().maxIterations(6).build(), tokenizer,
                        conversations, null, null, null, null))
                .usage(new ContextUsageReporter(tokenizer, 64_000, events, 1))
                .invoker(new DefaultChatModelInvoker(command -> {
                    seenRequests.add(List.copyOf(command.getMessages()));
                    int round = modelCalls.incrementAndGet();
                    if (round == 1) {
                        return response("我先给出计划，等你确认。", List.of(new ToolCallRequest(TOOL_CALL_ID, PLAN_TOOL, 0,
                                "{\"title\":\"重构步骤\",\"text\":\"1. 收口审批\\n2. 收口恢复\"}")));
                    }
                    return response("已按计划执行完毕。", List.of());
                })).build());
    }

    /** 计划工具：返回 promise 即代表「等用户批准」，与生产 create_plan 同一语义。 */
    private ToolExecutionManager toolManager() {
        ToolExecutor planner = execution -> ToolExecuteResult.promise("Waiting for the user.");
        ToolDefinition<ToolExecutor> plan = ToolDefinition.<ToolExecutor>builder()
                .id(PLAN_TOOL).name(PLAN_TOOL).executor(planner).maxOutput(2048).timeout(10L)
                .description("给出计划并等待用户确认")
                .parametersJsonSchema("{\"type\":\"object\",\"properties\":{}}")
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION).build();
        ToolRegistry registry = new ToolRegistry(List.of(plan));
        return new ToolExecutionManager() {
            @Override
            public ToolRegistry toolRegistry() {
                return registry;
            }

            @Override
            public List<ToolExecuteResult> execute(ToolExecuteCommand command) {
                List<ToolExecuteResult> results = new ArrayList<>();
                for (ToolCallRequest call : command.requests()) {
                    ToolDefinition<?> definition = registry.getTool(call.name());
                    assertNotNull(definition, "未注册的工具: " + call.name());
                    ToolExecuteResult result = definition.executor().execute(ToolExecution.builder()
                            .id(call.id()).executionId(command.executionId()).args(call.arguments())
                            .attributes(command.attributes()).build());
                    result.setId(call.id());
                    result.setRequestIndex(call.requestIndex());
                    result.setToolSpecification(definition);
                    results.add(result);
                }
                return results;
            }
        };
    }

    private Execution newExecution() {
        AgentRequest request = AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION_ID)))
                        .build())
                .contextSpec(ContextSpec.builder()
                        .context(new ArrayList<>(List.of(UserMessageEntity.from(QUESTION))))
                        .build())
                .build();
        Execution execution = Execution.builder().id(EXECUTION_ID_TEXT).agentId("chatAgent")
                .agentRequest(request).executionState(ExecutionState.CREATED)
                .messages(new ArrayList<>(List.of(UserMessageEntity.from(QUESTION)))).build();
        execution.setTokenUsage(TokenUsageEntity.empty());
        execution.setMaxSteps(6);
        return execution;
    }

    /** 把框架挂起时留下的 promise 卡片登记成真实领域行（生产由 ToolCallRegistrar 完成）。 */
    private void registerPlanCard() {
        tools.save(ToolCall.builder().id(TOOL_CALL_ID).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName(PLAN_TOOL).type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("重构步骤").content("{\"kind\":\"PLAN\",\"title\":\"重构步骤\",\"text\":\"1\"}")
                .rawInput("{\"args\":{}}").build());
    }

    /** 等恢复真的跑完：状态必须由生产代码写成终态，不用测试自己动手。 */
    private Execution awaitTerminal() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            Execution latest = executions.findById(EXECUTION_ID_TEXT).orElse(null);
            if (latest != null && latest.getExecutionState() != null
                    && latest.getExecutionState().isTerminal()) {
                return latest;
            }
            Thread.sleep(25L);
        }
        Execution latest = executions.findById(EXECUTION_ID_TEXT).orElse(null);
        fail("恢复没有把执行带到终态，当前: "
                + (latest == null ? "null" : latest.getExecutionState()) + "，模型调用次数: " + modelCalls.get());
        return null;
    }

    private String slotOutput(Execution execution, String toolCallId) {
        return execution.getMessages().stream()
                .filter(com.summit.core.conversation.message.ToolMessageEntity.class::isInstance)
                .map(com.summit.core.conversation.message.ToolMessageEntity.class::cast)
                .filter(message -> toolCallId.equals(String.valueOf(message.getId())))
                .map(com.summit.core.conversation.message.ToolMessageEntity::getToolOutput)
                .findFirst().orElse("");
    }

    private String lastUserText(List<Message> messages) {
        return messages.stream().filter(UserMessageEntity.class::isInstance)
                .map(Message::text).reduce((first, second) -> second).orElse("");
    }

    /** 恢复请求行计数与状态：真实 SQL，不信内存标记。 */
    private long resumeRows() {
        return Long.parseLong(database.queryString("select count(*) from execution_resume_task where execution_id = "
                + EXECUTION_ID + " and trigger_type = 'APPROVAL_DECISION'"));
    }

    private String resumeState() {
        return database.queryString("select state from execution_resume_task where execution_id = " + EXECUTION_ID
                + " order by id desc limit 1");
    }

    /** 等请求行被 worker 以成功收尾：终态先落库，请求行随后才标记，读一次会撞上 CLAIMED。 */
    private String awaitResumeState() throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String state = resumeState();
        while (System.nanoTime() < deadline) {
            if ("SUCCEEDED".equals(state) || "FAILED".equals(state) || "DEFERRED".equals(state)
                    || "SUPERSEDED".equals(state)) {
                return state;
            }
            Thread.sleep(25L);
            state = resumeState();
        }
        return state;
    }

    private static ChatResponseEntity response(String text, List<ToolCallRequest> calls) {
        return ChatResponseEntity.builder()
                .aiMessageEntity(AiMessageEntity.builder().text(text).toolCalls(calls).build())
                .tokenUsage(TokenUsageEntity.empty()).build();
    }
}

package com.summit.dp.toolcall;

import com.summit.dp.workflow.application.lifecycle.CoordinatorResumeAcceptance;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ApprovalOutcome;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.workflow.application.decision.ApprovalFinalizer;
import com.summit.dp.workflow.application.decision.ApprovedCommandRestorer;
import com.summit.dp.workflow.application.decision.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.decision.CommandApprovalExecutor;
import com.summit.dp.workflow.application.decision.CommandOutcomeResolver;
import com.summit.dp.workflow.application.decision.ToolCallDecisionService;
import com.summit.dp.workflow.application.decision.ToolCallWorkflowService;
import com.summit.dp.workflow.application.decision.VersionedToolCallDecisionService;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.decision.VersionedDecisionContract;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
/**
 * 命令两阶段的故障注入守卫（真实 H2 + 真实事务 + 真实入口）。
 *
 * <p><b>为什么必须用真库真事务</b>：本轮全部不变量都是「事务边界与顺序」——
 * T1 提交是否早于副作用、T2 是否与真实输出同批、冷重建后会不会重放。
 * 把事务 mock 掉，这些顺序就都断言不到。</p>
 *
 * <p><b>命令本身不真跑</b>：外部进程用计数器替身 {@link CountingCommandExecutor} 代替，
 * 它只回答两件事：跑了几次、跑的那一刻库里是什么。真跑外部进程会让用例不可重复，
 * 也会把「有没有重放」掩盖在进程语义里。</p>
 */
class CommandTwoPhaseGuardTest {

    private static final long CONV_V1 = 8101L;
    private static final long CONV_V2 = 8102L;
    private static final long EXEC_V1 = 8201L;
    private static final long EXEC_V2 = 8202L;
    private static final String CARD_V1 = "cmd-v1-card";
    private static final String CARD_V2 = "cmd-v2-card";
    /** 副作用替身返回的命令输出：断言里的字面量。 */
    private static final String STDOUT = "OUT-FROM-COMMAND";
    /** T1 事务里的槽位占位输出：T2 之前库内必须是它。 */
    private static final String PLACEHOLDER = "命令已批准，正在执行";

    private H2TestDatabase database;
    private SqlSessionTemplate session;
    private ObjectMapper mapper;
    private FlakyToolCalls tools;
    private LocalExecutionRepository executions;
    private ModelContextService contexts;
    private TransactionTemplate transactions;
    private ToolCallConverter converter;
    private ExecutionControl executionControl;
    private ExecutionActivity activity;
    private InteractionDecisionEngine engine;
    private ToolCallWorkflowService workflowService;
    private VersionedToolCallDecisionService versionedService;
    private TwoPhaseCommandResolutionStrategy commandStrategy;
    private CommandApprovalExecutor executor;
    private ExecutionResumeCoordinator coordinator;
    private RecordingSseEventPublisher sse;
    private CountingCommandExecutor command;
    private RecordingResumer resumer;
    private WorkspaceResolver workspaces;
    private ToolRegistry registry;
    private final List<ExecutionResumeCoordinator> coordinators = new ArrayList<>();
    private final Map<String, Integer> resumeStarts = new ConcurrentHashMap<>();

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("CommandTwoPhaseGuardTest");
        mapper = new ObjectMapper().findAndRegisterModules();
        session = H2TestDatabase.sqlSession(database.sessionFactory(
                com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper.class,
                ToolCallMapper.class, SessionContextMapper.class, SessionMessageMapper.class,
                SessionMapper.class,
                com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper.class));
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
        activity = mock(ExecutionActivity.class);
        executionControl = mock(ExecutionControl.class);
        // 生产 DefaultExecutionController 的 beginApproval 会先 resumeChecked 再 save，桩必须同款落库，
        // 否则「T1 已提交」这件事实在库里根本不存在。
        doAnswer(invocation -> {
            Execution target = invocation.getArgument(0);
            target.resumeChecked();
            executions.save(target);
            return null;
        }).when(executionControl).beginApproval(any(Execution.class));
        doAnswer(invocation -> {
            Execution target = invocation.getArgument(0);
            if (invocation.getArgument(1) == ApprovalOutcome.CANCELLED) {
                target.cancelChecked();
            } else {
                target.suspendChecked();
            }
            executions.save(target);
            return null;
        }).when(executionControl).finishApproval(any(Execution.class), any(ApprovalOutcome.class));
        doAnswer(invocation -> {
            Execution target = invocation.getArgument(0);
            target.failChecked(invocation.getArgument(1));
            executions.save(target);
            return null;
        }).when(executionControl).failApproval(any(Execution.class), anyString());
        when(executionControl.resume(any(Execution.class))).thenAnswer(invocation -> invocation.getArgument(0));

        tools = new FlakyToolCalls(session.getMapper(ToolCallMapper.class), mapper,
                mock(CardAvailabilityPolicy.class), database);
        executions = com.summit.dp.execution.ExecutionRepositoryTestFactory.create(
                session.getMapper(com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper.class),
                mapper);
        contexts = new ModelContextService(
                new SessionContextRepositoryImpl(session.getMapper(SessionContextMapper.class)),
                new LocalSessionContextFileStore(
                        ExecutionRepositoryTestFactory.tempDataDir().toString(), mapper));
        converter = new ToolCallConverter(mapper);
        command = new CountingCommandExecutor(mapper, database, cardId -> slotText(cardId));
        registry = mock(ToolRegistry.class);
        when(registry.getTool("command")).thenReturn(toolDefinition());
        workspaces = mock(WorkspaceResolver.class);
        // 先造桩对象再注册：把 mock 构造写进 thenReturn 会与「正在进行的 stubbing」打架。
        Workspace workspace = workspace();
        when(workspaces.resolve(any())).thenReturn(workspace);
        resumer = new RecordingResumer(new SessionAttributeRestorer(mock(SessionRepository.class)),
                contexts, provider(executionControl), resumeStarts);
        sse = new RecordingSseEventPublisher();
        assemble();
        stageCommandCard(CONV_V1, EXEC_V1, CARD_V1);
        stageCommandCard(CONV_V2, EXEC_V2, CARD_V2);
    }

    @AfterEach
    void close() {
        coordinators.forEach(ExecutionResumeCoordinator::close);
        if (sse != null) {
            sse.close();
        }
        coordinators.clear();
        database.shutdown();
    }

    /** 按生产依赖顺序装配；冷重建用例会再调一次，用同一套装配造出「重启后的新进程」。 */
    private void assemble() {
        coordinator = new ExecutionResumeCoordinator(
                new com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl(
                        session.getMapper(
                                com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper.class)),
                new com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl(
                        session.getMapper(
                                com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper.class)),
                resumer, executionControl,
                new SuspensionGateChain(List.of(new UserPauseSuspensionGate(),
                        new UnresolvedToolSuspensionGate(tools),
                        new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                                mock(SessionRepository.class),
                                mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class))))),
                new UnresolvedToolSuspensionGate(tools), provider(executions), provider(activity),
                new StartupFailureCloser(executionControl));
        coordinators.add(coordinator);
        executor = new CommandApprovalExecutor(tools, converter, transactions, provider(executionControl),
                provider(executions),
                new CommandOutcomeResolver(converter, mock(RuntimeEventPublisher.class)),
                new ApprovalFinalizer(tools, converter, contexts, mock(RuntimeEventPublisher.class),
                        transactions, provider(executionControl), resumer, new CoordinatorResumeAcceptance(coordinator)),
                new UnresolvedToolSuspensionGate(tools),
                new ApprovedCommandRestorer(mapper, workspaces, provider(registry)),
                contexts, new CoordinatorResumeAcceptance(coordinator), new ManagedAsyncExecutor());
        commandStrategy = new TwoPhaseCommandResolutionStrategy(executor, tools, converter);
        engine = new InteractionDecisionEngine(tools, converter, provider(executions), contexts, transactions,
                new CoordinatorResumeAcceptance(coordinator), new UnresolvedToolSuspensionGate(tools),
                new ImmediateSlotResolutionStrategy(converter, mock(ChoiceAnswersValidator.class), tools),
                commandStrategy);
        ReactiveDecisionContract reactive = new ReactiveDecisionContract(
                new CardAvailabilityPolicy(new HarnessExecutionGate(provider(executions), provider(activity))));
        workflowService = new ToolCallWorkflowService(tools, converter, engine,
                new ToolCallDecisionService(locator(), sse, engine, reactive), reactive, sse, locator());
        versionedService = new VersionedToolCallDecisionService(tools, converter, engine,
                new VersionedDecisionContract(converter));
    }

    // ------------------------------------------------------------------
    // 1) v1 与 v2 命令入口等价
    // ------------------------------------------------------------------

    @Test
    @DisplayName("1) 同一批准经 v1 与 v2：状态/结论/摘要/占位与最终槽位/恢复请求行逐字段一致")
    void v1AndV2CommandPathsPersistIdentically() {
        workflowService.decide(CONV_V1, CARD_V1, true, "可以");
        versionedService.decide(new ToolCallDecisionCommand(CONV_V2, CARD_V2, "cmd-v2", 1L,
                ToolCallAction.APPROVE, "可以"));

        awaitInvocations(1, 2);
        awaitOutcome(CARD_V1, "APPROVED");
        awaitOutcome(CARD_V2, "APPROVED");
        awaitStatus(CARD_V1, "completed");
        awaitStatus(CARD_V2, "completed");
        ToolCall fromV1 = tools.findById(CARD_V1).orElseThrow();
        ToolCall fromV2 = tools.findById(CARD_V2).orElseThrow();
        assertEquals("completed", status(fromV1.getId()));
        assertEquals("completed", status(fromV2.getId()));
        assertEquals(ToolCallStatus.COMPLETED, fromV1.getStatus());
        assertEquals(ToolCallStatus.COMPLETED, fromV2.getStatus());
        assertEquals(fromV1.getVersion(), fromV2.getVersion(), "两条入口推进的版本必须一致");
        assertTrue(fromV1.getVersion() > 1L, "版本必须推进");
        assertEquals("APPROVED", outcomeOf(CARD_V1));
        assertEquals("APPROVED", outcomeOf(CARD_V2));
        assertNotNull(fromV1.getDecisionDigest(), "v1 摘要也必须落库");
        assertNotNull(fromV2.getDecisionDigest());
        assertEquals(STDOUT, slotOf(CARD_V1).getToolOutput(), "最终槽位输出必须是命令真实输出");
        assertEquals(STDOUT, slotOf(CARD_V2).getToolOutput());
        assertEquals(1L, resumeRows(EXEC_V1));
        assertEquals(1L, resumeRows(EXEC_V2));
        assertEquals("APPROVAL_DECISION", resumeTrigger(EXEC_V1));
        assertEquals("APPROVAL_DECISION", resumeTrigger(EXEC_V2));
    }

    // ------------------------------------------------------------------
    // 2) T1 提交 < 副作用
    // ------------------------------------------------------------------

    @Test
    @DisplayName("2) 命令开跑那一刻库内已有占位结论 + 占位槽位 + 决策身份：T1 提交早于副作用")
    void t1CommitsBeforeSideEffect() {
        workflowService.decide(CONV_V1, CARD_V1, true, "可以");

        awaitInvocations(1, 1);
        command.awaitObserved();
        assertEquals("in_progress", command.observedStatus(), "副作用发生时卡片必须已是执行中");
        assertEquals("APPROVED", command.observedOutcome(), "占位结论必须先落库");
        assertEquals(PLACEHOLDER, command.observedSlot(), "槽位占位输出必须先落库");
        assertNotNull(command.observedDigest(), "决策身份必须先落库");
        assertNotNull(command.observedResumeRows(), "副作用那一刻必须读得到恢复请求计数");
        assertEquals(0L, Long.parseLong(command.observedResumeRows()),
                "T2 还没落结果，此刻不得已有恢复请求行（否则执行会在结论落库前被唤醒）");
        assertEquals(1, command.invocations());
    }

    // ------------------------------------------------------------------
    // 3) T1 失败：副作用一次都不执行
    // ------------------------------------------------------------------

    @Test
    @DisplayName("3) T1 失败（槽位定位失败）：副作用 0 次、无恢复请求行、卡片仍待处理")
    void t1FailureSkipsSideEffect() {
        // 抹掉执行里的工具槽位：T1 的槽位写入必然失败。
        Execution execution = executions.findById(String.valueOf(EXEC_V1)).orElseThrow();
        transactions.executeWithoutResult(status -> {
            execution.setMessages(new ArrayList<>(List.of(
                    AiMessageEntity.builder().toolCalls(List.of(ToolCallRequest.builder()
                            .id(CARD_V1).name("command").requestIndex(0).arguments("{}").build())).build())));
            executions.save(execution);
        });

        assertThrows(RuntimeException.class, () -> workflowService.decide(CONV_V1, CARD_V1, true, "可以"));

        assertEquals(0, command.invocations(), "T1 失败时命令一次都不能跑");
        assertEquals("pending", status(CARD_V1));
        assertEquals(0L, resumeRows(EXEC_V1), "T1 失败不得留下恢复请求行");
        assertEquals("suspended", executionStatus(EXEC_V1));
        assertFalse(executions.isActive(String.valueOf(EXEC_V1)), "T1 失败必须释放控制槽位");
    }

    // ------------------------------------------------------------------
    // 4) T1 提交后派发被拒
    // ------------------------------------------------------------------

    @Test
    @DisplayName("4) 派发被拒：执行收为 FAILED、控制槽位释放、v1 流关闭、不重跑命令")
    void dispatchRejectedSettlesExecutionAndClosesStream() {
        CommandApprovalExecutor rejecting = new CommandApprovalExecutor(tools, converter, transactions,
                provider(executionControl), provider(executions),
                new CommandOutcomeResolver(converter, mock(RuntimeEventPublisher.class)),
                new ApprovalFinalizer(tools, converter, contexts, mock(RuntimeEventPublisher.class),
                        transactions, provider(executionControl), resumer, new CoordinatorResumeAcceptance(coordinator)),
                new UnresolvedToolSuspensionGate(tools),
                new ApprovedCommandRestorer(mapper, workspaces, provider(registry)),
                contexts, new CoordinatorResumeAcceptance(coordinator), new ManagedAsyncExecutor()) {
            @Override
            protected void dispatchAsync(Runnable task) {
                throw new java.util.concurrent.RejectedExecutionException("执行器已关闭");
            }
        };
        rebind(rejecting);

        assertThrows(java.util.concurrent.RejectedExecutionException.class,
                () -> workflowService.decide(CONV_V1, CARD_V1, true, "可以"));

        assertEquals("failed", executionStatus(EXEC_V1), "T1 已提交，派发被拒必须当场收口");
        assertFalse(executions.isActive(String.valueOf(EXEC_V1)), "控制槽位必须释放");
        assertEquals("FAILED", outcomeOf(CARD_V1));
        // 卡片侧只落 conclusion：FAILED 分支的 raw_output 不带原因文本（原因落到执行侧失败信息），
        // 因此这里判「不再是 APPROVED 占位」而不是判文案。
        assertFalse(tools.findById(CARD_V1).orElseThrow().getRawOutput().contains("APPROVED"),
                "派发被拒不得把占位结论留在卡片上");
        assertEquals(0, command.invocations(), "派发被拒时命令一次都不能跑");
        assertEquals(1, sse.finishedCount(), "v1 的流必须关闭，不能悬挂");
    }

    // ------------------------------------------------------------------
    // 5) 副作用抛错
    // ------------------------------------------------------------------

    @Test
    @DisplayName("5) 副作用抛错：T2 不写真实输出、按 failApproval 收口、重试不再执行副作用")
    void sideEffectFailureFailsApprovalWithoutReplay() {
        command.failWith(new IllegalStateException("命令炸了"));

        workflowService.decide(CONV_V1, CARD_V1, true, "可以");

        awaitInvocations(1, 1);
        awaitOutcome(CARD_V1, "FAILED");
        awaitStatus(CARD_V1, "completed");
        assertEquals(1, command.invocations());
        assertEquals("FAILED", outcomeOf(CARD_V1));
        assertFalse(tools.findById(CARD_V1).orElseThrow().getRawOutput().contains(STDOUT),
                "失败时不得把命令输出当成已完成结果写入");
        assertEquals("failed", executionStatus(EXEC_V1));
        assertTrue(resumeRows(EXEC_V1) <= 1L, "失败不得重复派发恢复请求");

        // 重试：命令绝不能再跑第二遍（卡片已收口，重试只会拿到「已处理」而不会重放命令）。
        workflowService.decide(CONV_V1, CARD_V1, true, "可以");
        assertEquals(1, command.invocations(), "重试不得重跑外部命令");
    }

    // ------------------------------------------------------------------
    // 6) T2 事务失败
    // ------------------------------------------------------------------

    @Test
    @DisplayName("6) T2 事务失败：不伪造 COMPLETED，按既有失败语义收口")
    void t2FailureDoesNotFakeCompletion() {
        command.onExecute(() -> tools.failNextUpdate(1));

        workflowService.decide(CONV_V1, CARD_V1, true, "可以");

        awaitInvocations(1, 1);
        awaitOutcome(CARD_V1, "FAILED");
        assertEquals("FAILED", outcomeOf(CARD_V1), "T2 失败只能收成失败，不能落下 APPROVED");
        assertFalse(tools.findById(CARD_V1).orElseThrow().getRawOutput().contains(STDOUT));
        assertEquals("failed", executionStatus(EXEC_V1));
        assertEquals(1, command.invocations(), "T2 失败不得重跑命令");
    }

    // ------------------------------------------------------------------
    // 7) 冷重建
    // ------------------------------------------------------------------

    @Test
    @DisplayName("7) 冷重建（T1 已落库、进程崩溃）：不重跑命令，执行按不确定失败收口")
    void coldRebuildDoesNotReplayCommand() {
        // 崩溃模拟：T1 提交成功，但收尾任务永远没跑起来（dispatch 不派发）。
        CommandApprovalExecutor crashing = new CommandApprovalExecutor(tools, converter, transactions,
                provider(executionControl), provider(executions),
                new CommandOutcomeResolver(converter, mock(RuntimeEventPublisher.class)),
                new ApprovalFinalizer(tools, converter, contexts, mock(RuntimeEventPublisher.class),
                        transactions, provider(executionControl), resumer, new CoordinatorResumeAcceptance(coordinator)),
                new UnresolvedToolSuspensionGate(tools),
                new ApprovedCommandRestorer(mapper, workspaces, provider(registry)),
                contexts, new CoordinatorResumeAcceptance(coordinator), new ManagedAsyncExecutor()) {
            @Override
            protected void dispatchAsync(Runnable task) {
                // 进程在这里消失：任务从未运行。
            }
        };
        rebind(crashing);
        workflowService.decide(CONV_V1, CARD_V1, true, "可以");

        assertEquals("in_progress", status(CARD_V1), "T1 必须已提交（崩溃前的事实）");
        assertEquals("APPROVED", outcomeOf(CARD_V1), "占位结论在库里，但命令没跑过");
        assertEquals(0, command.invocations());

        // 重启：同一份库、全新装配，然后跑生产启动收尸。
        assemble();
        com.summit.dp.execution.domain.repository.ExecutionRepository startup =
                new com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl(
                        session.getMapper(
                                com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper.class));
        int reaped = startup.markOrphanRunsFailed();

        assertEquals(1, reaped, "崩溃时仍在 RUNNING 的执行必须被收口");
        assertEquals(0, command.invocations(), "重启后绝不能再跑一次命令");
        assertEquals("failed", executionStatus(EXEC_V1));
        assertEquals("in_progress", status(CARD_V1), "卡片停在执行中＝结果不确定，不伪造完成");
        assertEquals("APPROVED", outcomeOf(CARD_V1));
        assertEquals(0L, resumeRows(EXEC_V1), "不确定失败不登记恢复请求");
    }

    // ------------------------------------------------------------------
    // 8) 停止后迟到结果
    // ------------------------------------------------------------------

    @Test
    @DisplayName("8) 停止后迟到结果：执行不复活、不新增恢复请求、槽位不残留执行中")
    void lateResultAfterStopDoesNotRevive() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        command.onExecute(() -> {
            started.countDown();
            await(release);
        });

        workflowService.decide(CONV_V1, CARD_V1, true, "可以");
        assertTrue(started.await(10, TimeUnit.SECONDS), "命令必须真的开始跑，才谈得上迟到结果");
        // 命令运行期间用户停止该执行。
        executions.requireCancel(String.valueOf(EXEC_V1));
        release.countDown();

        awaitExecutionStatus(EXEC_V1, "cancelled");
        assertEquals("cancelled", executionStatus(EXEC_V1), "停止必须生效，且不得被迟到结果复活");
        assertEquals("completed", status(CARD_V1), "迟到结果可以落成卡片结论，但不得把执行拉回运行");
        assertEquals(0L, resumeRows(EXEC_V1), "停止后不得新增恢复请求");
        assertFalse(executions.isActive(String.valueOf(EXEC_V1)));
        assertEquals(1, command.invocations());
        assertEquals(ResumeDisposition.ENDED,
                coordinator.accept(EXEC_V1, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType
                        .APPROVAL_DECISION), "已结束的执行不得被再次唤醒");
        assertEquals(0L, resumeRows(EXEC_V1));
    }

    // ------------------------------------------------------------------
    // 9) 恢复只启动一次
    // ------------------------------------------------------------------

    @Test
    @DisplayName("9) 恢复只启动一次：重复派发不会二次起 loop，恢复请求行只有一条")
    void resumeStartsExactlyOnce() throws Exception {
        workflowService.decide(CONV_V1, CARD_V1, true, "可以");

        awaitInvocations(1, 1);
        awaitResumeSettled(EXEC_V1);
        int afterFirst = resumeStarts.getOrDefault(String.valueOf(EXEC_V1), 0);

        coordinator.dispatch(EXEC_V1);
        coordinator.dispatch(EXEC_V1);
        Thread.sleep(300L);

        assertEquals(1, afterFirst, "首次受理只允许启动一次恢复");
        assertEquals(1, resumeStarts.getOrDefault(String.valueOf(EXEC_V1), 0), "重复派发不得二次启动");
        assertEquals(1L, resumeRows(EXEC_V1), "恢复请求行只能有一条");
    }

    // ------------------------------------------------------------------
    // 10) 拒绝路径的关流时机
    // ------------------------------------------------------------------

    @Test
    @DisplayName("10) v1 拒绝：恢复请求行 1 条（APPROVAL_DECISION），流在恢复落定之后才关")
    void v1RejectClosesStreamOnlyAfterResumeSettles() {
        // 把恢复按住在「进行中」：此刻还没有落定，流必须仍然开着。
        CountDownLatch hold = new CountDownLatch(1);
        resumer.holdOn(hold);

        workflowService.decide(CONV_V1, CARD_V1, false, "");

        // 拒绝是同步落定的（无副作用、无 T2），返回时恢复请求行已经落库。
        assertEquals(1L, resumeRows(EXEC_V1), "拒绝也必须登记持久化恢复请求");
        assertEquals("APPROVAL_DECISION", resumeTrigger(EXEC_V1));
        awaitResumeStart(EXEC_V1, 1);
        assertEquals(0, sse.finishedCount(), "恢复还在进行中，此刻绝不能关流");

        hold.countDown();
        awaitFinishCount(1);
        assertEquals(1, sse.finishedCount(), "恢复落定后必须关流，且只关一次");
        assertEquals(1L, resumeRows(EXEC_V1), "关流不得增加恢复请求行");
    }

    // ------------------------------------------------------------------
    // 装配辅助
    // ------------------------------------------------------------------

    /** 把新的编排器接回引擎与两个入口：故障注入只换一个协作方，别的都不动。 */
    private void rebind(CommandApprovalExecutor replacement) {
        this.executor = replacement;
        commandStrategy = new TwoPhaseCommandResolutionStrategy(replacement, tools, converter);
        engine = new InteractionDecisionEngine(tools, converter, provider(executions), contexts, transactions,
                new CoordinatorResumeAcceptance(coordinator), new UnresolvedToolSuspensionGate(tools),
                new ImmediateSlotResolutionStrategy(converter, mock(ChoiceAnswersValidator.class), tools),
                commandStrategy);
        ReactiveDecisionContract reactive = new ReactiveDecisionContract(
                new CardAvailabilityPolicy(new HarnessExecutionGate(provider(executions), provider(activity))));
        workflowService = new ToolCallWorkflowService(tools, converter, engine,
                new ToolCallDecisionService(locator(), sse, engine, reactive), reactive, sse, locator());
        versionedService = new VersionedToolCallDecisionService(tools, converter, engine,
                new VersionedDecisionContract(converter));
    }

    /** 一条挂起执行 + 一张待批命令卡；命令快照与工作空间桩完全对得上。 */
    private void stageCommandCard(long conversationId, long executionId, String toolCallId) {
        ToolMessageEntity slot = ToolMessageEntity.builder().id(toolCallId).name("command")
                .toolOutput("pending").build();
        AiMessageEntity ai = AiMessageEntity.builder().toolCalls(List.of(ToolCallRequest.builder()
                .id(toolCallId).name("command").requestIndex(0).arguments("{}").build())).build();
        // 不带 workspaceSpec：Mockito 桩对象无法序列化进检查点快照，且生产对缺省规格有回落路径。
        AgentRequest request = AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(conversationId))).build())
                .build();
        Execution execution = Execution.builder().id(String.valueOf(executionId)).agentId("chatAgent")
                .lastResponseId("resp-" + executionId).agentRequest(request)
                .executionState(ExecutionState.CREATED).messages(new ArrayList<>(List.of(ai, slot))).build();
        transactions.executeWithoutResult(status -> {
            executions.save(execution);
            execution.startChecked();
            execution.suspendChecked();
            executions.save(execution);
        });
        contexts.replace(conversationId, execution.getMessages());
        tools.save(ToolCall.builder().id(toolCallId).conversationId(conversationId).executionId(executionId)
                .toolName("command").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("命令审批").content(commandContent()).rawInput("{\"args\":{\"command\":\"echo hi\"}}")
                .build());
    }

    /** 命令快照：与 {@link #workspace()}、{@link #commandTool()} 逐字段一致。 */
    private static String commandContent() {
        String args = "{\"command\":\"echo hi\"}";
        return "{\"kind\":\"COMMAND\",\"command\":\"echo hi\",\"workDir\":\"/project\","
                + "\"shell\":\"BASH\",\"workspaceId\":\"workspace\","
                + "\"args\":\"" + args.replace("\"", "\\\"") + "\"}";
    }

    private Workspace workspace() {
        Workspace workspace = mock(Workspace.class);
        com.summit.core.runtime.RuntimeEnvironment environment = mock(com.summit.core.runtime.RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.shellType()).thenReturn(com.summit.core.runtime.workspace.ShellType.BASH);
        return workspace;
    }

    @SuppressWarnings("unchecked")
    private ToolDefinition<com.summit.core.tool.ToolExecutor> toolDefinition() {
        // ToolRegistry 的返回类型是 ToolDefinition<ToolExecutor>：生产装配由泛型推断，
        // 用例里必须显式收敛一次，否则无法把它塞进注册表桩。
        return (ToolDefinition<com.summit.core.tool.ToolExecutor>) (ToolDefinition<?>) ToolDefinition
                .<CommandToolDefinitionExecutor>builder()
                .id("command").name("command").maxOutput(1000).timeout(30L)
                .executor(command).build();
    }

    private static com.summit.dp.execution.application.service.ExecutionLocator locator() {
        com.summit.dp.execution.application.service.ExecutionLocator locator =
                mock(com.summit.dp.execution.application.service.ExecutionLocator.class);
        when(locator.resolveRootSessionId(anyLong())).thenAnswer(invocation -> invocation.getArgument(0));
        return locator;
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }

    // ------------------------------------------------------------------
    // 断言辅助（一律读库，不信内存标记）
    // ------------------------------------------------------------------

    private String status(String cardId) {
        return database.queryString("select status from tool_call where id = '" + cardId + "'");
    }

    private String outcomeOf(String cardId) {
        String raw = database.queryString("select raw_output from tool_call where id = '" + cardId + "'");
        return raw == null ? null : ToolCallOutcomeProbe.outcome(raw);
    }

    /** 执行状态：库里存的是生产编码，这里按编码断言，不猜字符串。 */
    private String executionStatus(long executionId) {
        String code = database.queryString("select status from execution where id = " + executionId);
        if (code == null) {
            return null;
        }
        return switch (Integer.parseInt(code)) {
            case com.summit.dp.execution.ExecutionStatusCodes.CREATED -> "created";
            case com.summit.dp.execution.ExecutionStatusCodes.RUNNING -> "running";
            case com.summit.dp.execution.ExecutionStatusCodes.SUSPENDED -> "suspended";
            case com.summit.dp.execution.ExecutionStatusCodes.COMPLETED -> "completed";
            case com.summit.dp.execution.ExecutionStatusCodes.FAILED -> "failed";
            case com.summit.dp.execution.ExecutionStatusCodes.CANCELLED -> "cancelled";
            default -> "unknown-" + code;
        };
    }

    /** 槽位文本：按卡片反查它所属的执行，避免用例写死执行 id。 */
    private String slotText(String cardId) {
        ToolCall card = tools.findById(cardId).orElseThrow();
        return slotIn(String.valueOf(card.getExecutionId()), cardId).getToolOutput();
    }

    private ToolMessageEntity slotOf(String cardId) {
        return slotIn(String.valueOf(tools.findById(cardId).orElseThrow().getExecutionId()), cardId);
    }

    private ToolMessageEntity slotIn(String executionId, String cardId) {
        Execution execution = executions.findById(executionId).orElseThrow();
        return execution.getMessages().stream()
                .filter(message -> message instanceof ToolMessageEntity)
                .map(message -> (ToolMessageEntity) message)
                .filter(message -> cardId.equals(String.valueOf(message.getId())))
                .findFirst().orElseThrow();
    }

    private long resumeRows(long executionId) {
        return Long.parseLong(database.queryString(
                "select count(*) from execution_resume_task where execution_id = " + executionId));
    }

    private String resumeTrigger(long executionId) {
        return database.queryString("select trigger_type from execution_resume_task where execution_id = "
                + executionId + " order by id desc limit 1");
    }

    private void awaitInvocations(int expected, long timeoutSeconds) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
        while (System.nanoTime() < deadline) {
            if (command.invocations() >= expected) {
                return;
            }
            sleep();
        }
        assertEquals(expected, command.invocations(), "命令执行次数不符");
    }

    private void awaitOutcome(String cardId, String expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            if (expected.equals(outcomeOf(cardId))) {
                return;
            }
            sleep();
        }
        assertEquals(expected, outcomeOf(cardId), "卡片结论未到达期望值");
    }

    private void awaitStatus(String cardId, String expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            if (expected.equals(status(cardId))) {
                return;
            }
            sleep();
        }
        assertEquals(expected, status(cardId), "卡片状态未到达期望值");
    }

    private void awaitExecutionStatus(long executionId, String expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            if (expected.equals(executionStatus(executionId))) {
                return;
            }
            sleep();
        }
        assertEquals(expected, executionStatus(executionId), "执行状态未到达期望值");
    }

    private void awaitResumeSettled(long executionId) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            String state = database.queryString("select state from execution_resume_task where execution_id = "
                    + executionId + " order by id desc limit 1");
            if (state != null && !"READY".equals(state) && !"CLAIMED".equals(state)) {
                return;
            }
            sleep();
        }
    }

    /** 等恢复真的启动到第 expected 次：恢复必须在关流之前发生，否则「落定后才关」无从谈。 */
    private void awaitResumeStart(long executionId, int expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            if (resumeStarts.getOrDefault(String.valueOf(executionId), 0) >= expected) {
                return;
            }
            sleep();
        }
        assertEquals(expected, resumeStarts.getOrDefault(String.valueOf(executionId), 0), "恢复未启动");
    }

    /** 等关流次数达到 expected（关流由恢复落定回调触发，必须异步等待）。 */
    private void awaitFinishCount(int expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15L);
        while (System.nanoTime() < deadline) {
            if (sse.finishedCount() >= expected) {
                return;
            }
            sleep();
        }
        assertEquals(expected, sse.finishedCount(), "恢复落定后必须关流");
    }

    private static void sleep() {
        try {
            Thread.sleep(20L);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** 从 raw_output JSON 里读 outcome：解析走工具类，避免用例自己散拼正则。 */
    static final class ToolCallOutcomeProbe {

        private static final ObjectMapper MAPPER = new ObjectMapper();

        static String outcome(String raw) {
            try {
                return MAPPER.readTree(raw).path("outcome").asText();
            } catch (Exception unreadable) {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------
    // 替身与可观测实现
    // ------------------------------------------------------------------

    /**
     * 命令执行替身：只做两件事 —— 数执行次数、在「跑起来那一刻」读库。
     *
     * <p><b>读库必须直连 JDBC</b>：它跑在异步收尾线程上，用 SqlSessionTemplate 会和用例主线程
     * 争同一个会话。直连连接既线程安全，读到的也正是「已提交」的事实。</p>
     */
    static final class CountingCommandExecutor extends CommandToolDefinitionExecutor {

        private final H2TestDatabase database;
        private final AtomicInteger invocations = new AtomicInteger();
        private final AtomicReference<String> status = new AtomicReference<>();
        private final AtomicReference<String> outcome = new AtomicReference<>();
        private final AtomicReference<String> slot = new AtomicReference<>();
        private final AtomicReference<String> digest = new AtomicReference<>();
        private final AtomicReference<String> resumeRows = new AtomicReference<>();
        private final CountDownLatch observed = new CountDownLatch(1);
        private final AtomicReference<RuntimeException> failure = new AtomicReference<>();
        private final AtomicReference<Runnable> onExecute = new AtomicReference<>();
        private final java.util.function.Function<String, String> slotReader;

        CountingCommandExecutor(ObjectMapper mapper, H2TestDatabase database,
                                java.util.function.Function<String, String> slotReader) {
            super(mapper);
            this.database = database;
            this.slotReader = slotReader;
        }

        @Override
        public ToolExecuteResult execute(ToolExecution toolExecution) {
            invocations.incrementAndGet();
            // 跑起来那一刻的库内事实：T1 必须已经提交。
            status.set(database.queryString("select status from tool_call where id = '"
                    + toolExecution.getId() + "'"));
            String raw = database.queryString("select raw_output from tool_call where id = '"
                    + toolExecution.getId() + "'");
            outcome.set(ToolCallOutcomeProbe.outcome(raw));
            digest.set(database.queryString("select decision_digest from tool_call where id = '"
                    + toolExecution.getId() + "'"));
            slot.set(slotReader.apply(toolExecution.getId()));
            resumeRows.set(database.queryString("select count(*) from execution_resume_task where execution_id = "
                    + toolExecution.getExecutionId()));
            observed.countDown();
            Runnable hook = onExecute.get();
            if (hook != null) {
                hook.run();
            }
            RuntimeException toThrow = failure.get();
            if (toThrow != null) {
                throw toThrow;
            }
            return ToolExecuteResult.success(STDOUT);
        }

        void failWith(RuntimeException error) {
            failure.set(error);
        }

        void onExecute(Runnable hook) {
            onExecute.set(hook);
        }

        int invocations() {
            return invocations.get();
        }

        void awaitObserved() {
            await(observed);
        }

        String observedStatus() {
            return status.get();
        }

        String observedOutcome() {
            return outcome.get();
        }

        String observedSlot() {
            return slot.get();
        }

        String observedResumeRows() {
            return resumeRows.get();
        }

        String observedDigest() {
            return digest.get();
        }
    }

    /** 记录执行期槽位文本的工具仓储：T2 之前槽位必须是占位输出。 */
    static final class FlakyToolCalls extends ToolCallRepositoryImpl {

        private final AtomicInteger failUpdates = new AtomicInteger();

        FlakyToolCalls(ToolCallMapper mapper, ObjectMapper objectMapper, CardAvailabilityPolicy policy,
                       H2TestDatabase database) {
            super(mapper, objectMapper, policy);
        }

        @Override
        public void updateById(ToolCall model) {
            if (failUpdates.getAndUpdate(left -> left > 0 ? left - 1 : 0) > 0) {
                throw new IllegalStateException("注入的 T2 写入失败");
            }
            super.updateById(model);
        }

        void failNextUpdate(int times) {
            failUpdates.set(times);
        }


    }

    /**
     * 记录恢复启动次数的恢复器：只数「真的起了一次 loop」。
     *
     * <p>{@code gate} 非空时，恢复会先停在里面，用来把「恢复进行中」这个瞬间拉长成可断言的窗口 ——
     * 关流时机只有在恢复尚未落定时才有观察价值。</p>
     */
    static final class RecordingResumer extends SuspendedExecutionResumer {

        private final Map<String, Integer> starts;
        private final AtomicReference<CountDownLatch> gate = new AtomicReference<>();

        RecordingResumer(SessionAttributeRestorer restorer, ModelContextService contexts,
                         ObjectProvider<ExecutionControl> control, Map<String, Integer> starts) {
            super(restorer, contexts, control);
            this.starts = starts;
        }

        /** 让下一次（及之后持同一闩的）恢复停住，直到测试放行。 */
        void holdOn(CountDownLatch latch) {
            gate.set(latch);
        }

        @Override
        public void resume(Execution execution, Long conversationId) {
            starts.merge(String.valueOf(execution.getId()), 1, Integer::sum);
            CountDownLatch latch = gate.get();
            if (latch != null) {
                await(latch);
            }
            super.resume(execution, conversationId);
        }
    }

    /** 真实发布器 + 可观测收尾计数：连接与推送仍走生产实现。 */
    static final class RecordingSseEventPublisher extends SseEventPublisher {

        private final AtomicInteger finished = new AtomicInteger();

        @Override
        public void finish(SseEmitter emitter) {
            finished.incrementAndGet();
            super.finish(emitter);
        }

        int finishedCount() {
            return finished.get();
        }
    }
}


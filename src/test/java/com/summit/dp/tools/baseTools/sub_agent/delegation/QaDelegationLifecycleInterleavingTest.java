package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.shared.support.InputTestSupport;
import com.summit.dp.workflow.application.input.MailInputChannel;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.*;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.EmailLoopInterceptor;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.session.domain.repo.SessionRepository;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * 委派生命周期交错回归：把「注册表登记 + 结束事实协作 + 恢复协调器 + 收尾驻留判定 + 取信」
 * 五块真实协作件接在一起，验证缺口 1~4 在交错时序下仍然自洽。
 *
 * <p>与各单件测试的分工：单件测试锁死各自内部不变量，本测试锁死<b>接线</b>——唤醒目标是否是
 * 协作根执行、待处理输入是否在根挂起后被重放、待启动 / 挂起子执行是否仍算「未结束」、
 * 停止后迟到邮件的邮箱键是否仍指向协作根会话。任何一处接错，都会让根提前收尾或永久不被唤醒。</p>
 */
class QaDelegationLifecycleInterleavingTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long ROOT_AGENT_ID = 7L;
    private static final long CHILD_SESSION_ID = 555L;
    private static final long GENERATION = 3L;
    private static final long AWAIT_TIMEOUT_SECONDS = 10L;

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionAttributeRestorer sessionAttributeRestorer = mock(SessionAttributeRestorer.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionRepository frameworkExecutions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executions =
            mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);
    private final ExecutionResumeTaskRepository tasks = mock(ExecutionResumeTaskRepository.class);
    private final ExecutionLocator executionIdentity = mock(ExecutionLocator.class);
    private final EmailService emailService = mock(EmailService.class);

    /** 根执行是否仍持有控制槽位（决定唤醒是被保留还是立即派发）。 */
    private final AtomicBoolean rootActive = new AtomicBoolean(false);
    /** 真正落到 {@code ExecutionControl.resume} 的次数——「恢复」的可观测事实。 */
    private final AtomicInteger resumeCount = new AtomicInteger();

    private SessionExecutionRegistry registry;
    private ExecutionResumeCoordinator coordinator;
    private SubExecutionLifecycle lifecycle;
    private InputWakeupService wakeups;
    private final AtomicBoolean pendingInput = new AtomicBoolean();
    private SubAgentWaitInterceptor waitInterceptor;

    @BeforeEach
    void setup() {
        registry = new SessionExecutionRegistry();
        coordinator = new ExecutionResumeCoordinator(tasks, executions,
                new SuspendedExecutionResumer(sessionAttributeRestorer,
                        modelContextService, provider(executionControl)),
                executionControl, lifecycleGates(toolCallRepository),
                new UnresolvedToolSuspensionGate(toolCallRepository),
                provider(frameworkExecutions), provider(activity),
                new StartupFailureCloser(executionControl));
        wakeups = InputTestSupport.wakeup(coordinator, frameworkExecutions, activity, registry, emailService);
        SubAgentCompleteNotifier notifier = mock(SubAgentCompleteNotifier.class);
        doAnswer(call -> { pendingInput.set(true); return null; }).when(notifier).notifyCommander(any());
        doAnswer(call -> { pendingInput.set(true); return null; }).when(notifier).notifyAbandoned(anyLong(), anyLong());
        lifecycle = new SubExecutionLifecycle(registry, wakeups, executionIdentity, notifier);
        waitInterceptor = new SubAgentWaitInterceptor(InputTestSupport.collaboration(registry, emailService));

        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID + 1)).thenReturn(ROOT_SESSION_ID);
        when(activity.isActive(any())).thenAnswer(invocation -> rootActive.get());
        when(executionControl.resume(any())).thenAnswer(invocation -> {
            pendingInput.set(false);
            resumeCount.incrementAndGet();
            return invocation.getArgument(0);
        });
        when(executionControl.fail(any(), any())).thenReturn(() -> { });
        when(emailService.pendingItemsUndelivered(anyLong(), anyLong())).thenAnswer(call -> pendingInput.get()
                ? List.of(EmailMessageVO.builder().id(1L).senderId(8L).content("待处理交付").build()) : List.of());
        // 认领是注入前置：真实实现逐条认领，拿不到投递权就不注入。
        when(emailService.claimDelivery(anyLong(), any())).thenReturn(true);

        when(executions.findResumeGeneration(ROOT_EXECUTION_ID)).thenReturn(GENERATION);
        stubRootSummary(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(ROOT_EXECUTION_ID)))
                .thenReturn(Optional.of(rootExecution()));
        // 无事务同步时立即派发（真实 LocalExecutionRepository 的同款降级语义）。
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(frameworkExecutions).afterCommit(any());
        when(tasks.enqueue(anyLong(), anyLong(), any(), any())).thenReturn(newTask());
        when(tasks.findByExecutionId(ROOT_EXECUTION_ID)).thenAnswer(invocation -> List.of(newTask()));
        when(tasks.claim(any())).thenReturn(true);
        when(tasks.listLiveByExecution(ROOT_EXECUTION_ID)).thenReturn(List.of());
        when(tasks.updateState(any())).thenReturn(true);
        when(toolCallRepository.listUnresolvedByExecutionId(ROOT_EXECUTION_ID)).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        wakeups.close();
        coordinator.close();
    }

    // ------------------------------------------------------------------
    // ① 子任务尚未启动就收尾：待启动登记即「未结束」，根不得提前完成
    // ------------------------------------------------------------------

    @Test
    @DisplayName("① 待启动子执行：仍算未结束 → 根驻留不收尾；子执行从未建立（放弃）→ 结束事实唤醒根")
    void pendingStartChildKeepsRootFromFinishingUntilAbandoned() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        // 已受理但异步线程尚未开跑：只登记「待启动」，没有活线程。
        assertTrue(registry.registerPendingChild(ROOT_SESSION_ID, CHILD_SESSION_ID, String.valueOf(CHILD_SESSION_ID), null));

        InterceptorResult beforeAbandon = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(beforeAbandon.next(), "子任务已受理但没开跑时，根不得自然完成");
        assertEquals(LoopResult.Status.SUSPENDED, beforeAbandon.loopResult().status());

        // 子执行从未建立（落库前失败）：兜底结束事实移除待启动登记并在根活跃时待处理输入。
        lifecycle.abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, String.valueOf(CHILD_SESSION_ID), ROOT_EXECUTION_ID);
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        assertResumedCount(0);

        // 根挂起、控制槽位释放：待处理输入被重放 → 恢复。
        suspendRoot();
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ② 结束恰好撞上挂起：两种相对顺序都必须有一次恢复
    // ------------------------------------------------------------------

    @Test
    @DisplayName("②A 子执行先终结、根后挂起：唤醒先被保留，挂起后重放 → 恢复一次")
    void inputBeforeSuspendIsFoundByReleaseRecheck() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);

        // 最后一个子执行在根仍活跃时终结：此刻不能派发，登记为待处理输入。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        assertResumedCount(0);

        suspendRoot();
        awaitResumedCount(1);
    }

    @Test
    @DisplayName("②B 根先挂起、子执行后终结：结束事实直接唤醒根 → 恢复一次")
    void suspendBeforeFinishWakesRootDirectly() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);

        // 根先挂起、释放控制槽位（无待处理输入，flush 是 no-op）。
        suspendRoot();

        // 最后一个子执行随后终结：结束事实闭环直接派发恢复。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumedCount(1);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    @DisplayName("两个子执行中一个完成：无论根先挂起还是后挂起，均恢复取信并继续等待另一个")
    void firstCompletedChildWakesRootAndDeliversNotice(boolean finishBeforeSuspend) {
        AtomicReference<EmailMessageVO> pendingMail = new AtomicReference<>();
        List<Message> appended = new ArrayList<>();
        lifecycle = new SubExecutionLifecycle(registry, wakeups, executionIdentity, new SubAgentCompleteNotifier(provider(frameworkExecutions), emailService));
        when(emailService.sendMailOnce(eq(ROOT_AGENT_ID), any(), any(), any())).thenAnswer(invocation -> {
            EmailMessageVO mail = EmailMessageVO.builder().id(1L).emailId(9L).senderId(8L)
                    .content(invocation.getArgument(1)).build();
            pendingMail.set(mail);
            return Result.success(mail);
        });
        when(emailService.pendingItemsUndelivered(ROOT_SESSION_ID, ROOT_AGENT_ID))
                .thenAnswer(invocation -> pendingMail.get() == null ? List.of() : List.of(pendingMail.get()));
        EmailLoopInterceptor mailConsumer = new EmailLoopInterceptor(new MailInputChannel(emailService));
        doAnswer(invocation -> {
            Execution root = invocation.getArgument(0);
            LoopContext context = LoopContext.builder().loopMessages(LoopMessages.builder().execution(root).build()).signal(new ExecutionControlSignal(root.getId())).consecutiveCompactTurns(() -> 0).appendMessage(appended::addAll).build();
            mailConsumer.onBeforeModelInvoke(context);
            // 回执由检查点保存路径落库；这是「已投递」的可观测等价事实，后续轮次不该再取到它。
            pendingMail.set(null);
            resumeCount.incrementAndGet();
            return root;
        }).when(executionControl).resume(any());

        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);
        delegateChild(CHILD_SESSION_ID + 1);
        if (!finishBeforeSuspend) {
            suspendRoot();
        }
        Execution completed = childExecution(CHILD_SESSION_ID);
        completed.complete();
        lifecycle.onFinished(completed);
        if (finishBeforeSuspend) {
            assertResumedCount(0);
            suspendRoot();
        }

        awaitResumedCount(1);
        assertEquals(1, appended.size());
        assertTrue(((UserMessageEntity) appended.getFirst()).text().contains("子任务已完成"));
        assertTrue(((UserMessageEntity) appended.getFirst()).text().contains("子会话：" + CHILD_SESSION_ID));
        assertFalse(emailService.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        InterceptorResult waiting = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(waiting.next(), "已处理首个交付后仍须等待另一子执行，不能提前完成");
        assertEquals(LoopResult.Status.SUSPENDED, waiting.loopResult().status());
    }

    // ------------------------------------------------------------------
    // ③ 连续两次恢复：每一轮委派都能独立唤醒根
    // ------------------------------------------------------------------

    @Test
    @DisplayName("③ 连续两轮委派：每轮最后一个子执行终结都唤醒根，产生两次恢复")
    void twoConsecutiveRoundsEachWakeRootOnce() {
        // 第一轮。
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        suspendRoot();
        awaitResumedCount(1);

        // 第二轮：根被恢复后再次委派另一个子执行。
        rootActive.set(true);
        delegateChild(CHILD_SESSION_ID + 1);
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID + 1));
        suspendRoot();
        awaitResumedCount(2);
    }

    // ------------------------------------------------------------------
    // ④ 子执行等待人工审批：挂起期仍「未结束」，审批落地后唤醒根
    // ------------------------------------------------------------------

    @Test
    @DisplayName("④ 子执行等待审批：挂起期根驻留不收尾；子执行终结后才唤醒根")
    void childWaitingApprovalKeepsRootAndWakesOnFinish() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);

        // 子执行挂起等审批：保留登记、释放死线程，但父侧仍算「未结束」。

        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID), "等审批的子执行仍是未结束子执行");

        InterceptorResult whileWaiting = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(whileWaiting.next(), "有等审批的子执行时根不得收尾");
        assertResumedCount(0);

        suspendRoot();

        // 审批通过并行至终态：结束事实唤醒根。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ⑥ 子执行失败立即唤醒暂停中的主理人
    // ------------------------------------------------------------------

    @Test
    @DisplayName("⑥ 根已暂停时子执行失败：立即恢复主理人，不等其他队员结束")
    void failedChildImmediatelyWakesSuspendedCommander() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        delegateChild(CHILD_SESSION_ID);
        delegateChild(CHILD_SESSION_ID + 1);
        suspendRoot();
        assertNoResume();

        Execution failed = childExecution(CHILD_SESSION_ID);
        failed.fail("模型连接失败");
        lifecycle.onFinished(failed);

        awaitResumedCount(1);
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID), "失败队员退出，其他队员仍保留登记");
    }

    // ------------------------------------------------------------------
    // ⑤ 停止后迟到邮件：邮箱业务键是协作根会话 id，跨执行轮次仍可被消费
    // ------------------------------------------------------------------

    @Test
    @DisplayName("⑤ 停止后迟到邮件：取信键恒为协作根会话 id，下一轮执行仍能消费到")
    void lateMailAfterStopIsConsumedByNextRoundUnderRootSessionKey() {
        EmailService mailbox = mock(EmailService.class);
        AtomicReference<long[]> consumedKey = new AtomicReference<>();
        when(mailbox.pendingItemsUndelivered(anyLong(), anyLong())).thenAnswer(invocation -> {
            consumedKey.set(new long[]{invocation.getArgument(0), invocation.getArgument(1)});
            return List.of();
        });
        when(mailbox.claimDelivery(anyLong(), any())).thenReturn(true);
        EmailLoopInterceptor mailConsumer = new EmailLoopInterceptor(new MailInputChannel(mailbox));

        // 停止之后、下一轮 beginRoot 之前到达的邮件：按协作根会话 id 落箱。
        // 新一轮执行的执行 id 与上一轮不同，但会话 id 不变 —— 取信键必须仍命中同一把邮箱。
        mailConsumer.onBeforeModelInvoke(loopContext("1001", Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID))));
        assertArrayEquals(new long[]{ROOT_SESSION_ID, ROOT_AGENT_ID}, consumedKey.get(),
                "根执行取信键 = 自身会话 id（即协作根会话 id）");

        // 子执行发信 / 收信落到同一把键：ROOT_SESSION_ID 优先于子会话 id 与任何执行 id。
        mailConsumer.onBeforeModelInvoke(loopContext("1234", Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID))));
        assertArrayEquals(new long[]{ROOT_SESSION_ID, ROOT_AGENT_ID}, consumedKey.get(),
                "子执行取信键同样收敛到协作根会话 id");
    }

    // ------------------------------------------------------------------
    // 编排辅助
    // ------------------------------------------------------------------

    /** 根进入 SUSPENDED 并释放控制槽位：走真实挂起通知链（含输入复查）。 */
    private void suspendRoot() {
        rootActive.set(false);

        wakeups.resumeIfInputPending(ROOT_EXECUTION_ID);
    }

    private void delegateChild(long childSessionId) {
        registry.registerPendingChild(ROOT_SESSION_ID, childSessionId, String.valueOf(childSessionId), null);
        registry.registerPendingChild(ROOT_SESSION_ID, childSessionId, String.valueOf(childSessionId), null);
    }

    private LoopContext rootLoopContext() {
        return loopContext(String.valueOf(ROOT_EXECUTION_ID), Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID)));
    }

    private static LoopContext loopContext(String executionId, Map<String, Object> attributes) {
        List<Message> appended = new ArrayList<>();
        Execution execution = Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder()
                        .workspaceSpec(TEST_WORKSPACE)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
        LoopMessages loopMessages = LoopMessages.builder().execution(execution).build();
        return LoopContext.builder().loopMessages(loopMessages).signal(new ExecutionControlSignal(executionId)).consecutiveCompactTurns(() -> 0).appendMessage(appended::addAll).build();
    }

    private static Execution childExecution(long childSessionId) {
        return Execution.builder().id(String.valueOf(childSessionId))
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(childSessionId),
                                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                                ExecutionAttributes.AGENT_ID, "8",
                                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID)))
                                .build())
                        .build())
                .build();
    }

    private static Execution rootExecution() {
        // 检查点必须是 SUSPENDED：恢复 worker 只对「停在挂起点」的执行真正 resume。
        return Execution.builder().id(String.valueOf(ROOT_EXECUTION_ID))
                .executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID)))
                                .build())
                        .build())
                .build();
    }

    private void stubRootSummary(ExecutionState state) {
        com.summit.dp.execution.domain.model.Execution summary =
                new com.summit.dp.execution.domain.model.Execution();
        summary.setId(ROOT_EXECUTION_ID);
        summary.setSessionId(ROOT_SESSION_ID);
        summary.setStatus(ExecutionStateCodec.encode(state));
        summary.setResumeGeneration(GENERATION);
        when(executions.findSummariesByIds(any())).thenReturn(List.of(summary));
    }

    private ExecutionResumeTask newTask() {
        return ExecutionResumeTask.builder().id(1L).executionId(ROOT_EXECUTION_ID)
                .generation(GENERATION).state(ResumeTaskState.READY).version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    /** 断言此刻尚无恢复落点（合成结束事实后立刻检查，不等 worker）。 */
    private void assertResumedCount(int expected) {
        assertEquals(expected, resumeCount.get(),
                "此刻不应发生恢复，实际恢复次数=" + resumeCount.get());
    }

    /**
     * 有界自旋确认「此刻不应发生恢复」：worker 在独立线程派发，给一个确定性的观察窗口，
     * 一旦观察到恢复立即判红；窗口内始终为 0 才算通过。用有界自旋而非固定 sleep，命中即返回。
     */
    private void assertNoResume() {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(500);
        while (resumeCount.get() == 0 && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertResumedCount(0);
    }

    /** worker 在独立线程派发；用自旋等待对齐，不用固定 sleep 赌。 */
    private void awaitResumedCount(int expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(AWAIT_TIMEOUT_SECONDS);
        while (resumeCount.get() < expected && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertEquals(expected, resumeCount.get(),
                "应在超时前观察到 " + expected + " 次恢复，实际=" + resumeCount.get());
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }

    private static final WorkspaceSpec TEST_WORKSPACE = new WorkspaceSpec() {
        @Override
        public String provider() {
            return "test";
        }

        @Override
        public String workDir() {
            return "D:/tmp";
        }
    };
    /** 恢复消费端锁内复检用的门禁链：与生产装配同一份顺序，避免测试另造一套口径。 */
    private static SuspensionGateChain lifecycleGates(ToolCallRepository toolCalls) {
        return new SuspensionGateChain(List.of(
                new UserPauseSuspensionGate(),
                new UnresolvedToolSuspensionGate(toolCalls),
                new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                        mock(SessionRepository.class),
                        mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class)))));
    }
}

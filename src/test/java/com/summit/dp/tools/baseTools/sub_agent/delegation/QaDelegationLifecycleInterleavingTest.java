package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.communication.AgenticLoopInterceptor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
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

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 委派生命周期交错回归：把「注册表登记 + 结束事实协作 + 恢复协调器 + 收尾驻留判定 + 取信」
 * 五块真实协作件接在一起，验证缺口 1~4 在交错时序下仍然自洽。
 *
 * <p>与各单件测试的分工：单件测试锁死各自内部不变量，本测试锁死<b>接线</b>——唤醒目标是否是
 * 协作根执行、保留唤醒是否在根挂起后被重放、待启动 / 挂起子执行是否仍算「未结束」、
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
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final EmailService emailService = mock(EmailService.class);

    /** 根执行是否仍持有控制槽位（决定唤醒是被保留还是立即派发）。 */
    private final AtomicBoolean rootActive = new AtomicBoolean(false);
    /** 真正落到 {@code ExecutionControl.resume} 的次数——「恢复」的可观测事实。 */
    private final AtomicInteger resumeCount = new AtomicInteger();

    private SessionExecutionRegistry registry;
    private ExecutionResumeCoordinator coordinator;
    private SubExecutionLifecycle lifecycle;
    private SubAgentWaitInterceptor waitInterceptor;

    @BeforeEach
    void setup() {
        registry = new SessionExecutionRegistry();
        coordinator = new ExecutionResumeCoordinator(tasks, executions,
                new SuspendedExecutionResumer(toolCallRepository, sessionAttributeRestorer,
                        modelContextService, provider(executionControl)),
                executionControl, provider(frameworkExecutions), provider(activity));
        lifecycle = new SubExecutionLifecycle(registry, coordinator, executionIdentity);
        waitInterceptor = new SubAgentWaitInterceptor(registry, emailService, coordinator);

        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID + 1)).thenReturn(ROOT_SESSION_ID);
        when(activity.isActive(any())).thenAnswer(invocation -> rootActive.get());
        when(executionControl.resume(any())).thenAnswer(invocation -> {
            resumeCount.incrementAndGet();
            return invocation.getArgument(0);
        });
        when(executionControl.fail(any(), any())).thenReturn(() -> { });
        when(emailService.hasPending(anyLong(), anyLong())).thenReturn(false);

        when(executions.findResumeGeneration(ROOT_EXECUTION_ID)).thenReturn(GENERATION);
        stubRootSummary(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(ROOT_EXECUTION_ID)))
                .thenReturn(Optional.of(rootExecution()));
        // 无事务同步时立即派发（真实 LocalExecutionRepository 的同款降级语义）。
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(frameworkExecutions).afterCommit(any());
        when(tasks.enqueue(anyLong(), anyLong(), any())).thenReturn(newTask());
        when(tasks.findByExecutionId(ROOT_EXECUTION_ID)).thenAnswer(invocation -> List.of(newTask()));
        when(tasks.claim(any())).thenReturn(true);
        when(tasks.listLiveByExecution(ROOT_EXECUTION_ID)).thenReturn(List.of());
        when(tasks.updateState(any())).thenReturn(true);
        when(toolCallRepository.listUnresolvedByExecutionId(ROOT_EXECUTION_ID)).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        coordinator.close();
    }

    // ------------------------------------------------------------------
    // ① 子任务尚未启动就收尾：待启动登记即「未结束」，根不得提前完成
    // ------------------------------------------------------------------

    @Test
    @DisplayName("① 待启动子执行：仍算未结束 → 根驻留不收尾；子执行从未建立（放弃）→ 结束事实唤醒根")
    void pendingStartChildKeepsRootFromFinishingUntilAbandoned() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        // 已受理但异步线程尚未开跑：只登记「待启动」，没有活线程。
        assertTrue(registry.registerPendingChild(ROOT_SESSION_ID, CHILD_SESSION_ID));

        InterceptorResult beforeAbandon = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(beforeAbandon.shouldContinue(), "子任务已受理但没开跑时，根不得自然完成");
        assertEquals(LoopResult.Status.SUSPENDED, beforeAbandon.loopResult().status());

        // 子执行从未建立（落库前失败）：兜底结束事实移除待启动登记并在根活跃时保留唤醒。
        lifecycle.abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        assertResumedCount(0);

        // 根挂起、控制槽位释放：保留唤醒被重放 → 恢复。
        suspendRoot();
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ② 结束恰好撞上挂起：两种相对顺序都必须有一次恢复
    // ------------------------------------------------------------------

    @Test
    @DisplayName("②A 子执行先终结、根后挂起：唤醒先被保留，挂起后重放 → 恢复一次")
    void finishBeforeSuspendRetainsWakeThenReplays() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateChild(CHILD_SESSION_ID);

        // 最后一个子执行在根仍活跃时终结：此刻不能派发，登记为保留唤醒。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        assertResumedCount(0);

        suspendRoot();
        awaitResumedCount(1);
    }

    @Test
    @DisplayName("②B 根先挂起、子执行后终结：结束事实直接唤醒根 → 恢复一次")
    void suspendBeforeFinishWakesRootDirectly() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateChild(CHILD_SESSION_ID);

        // 根先挂起、释放控制槽位（无保留唤醒，flush 是 no-op）。
        suspendRoot();

        // 最后一个子执行随后终结：结束事实闭环直接派发恢复。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ③ 连续两次恢复：每一轮委派都能独立唤醒根
    // ------------------------------------------------------------------

    @Test
    @DisplayName("③ 连续两轮委派：每轮最后一个子执行终结都唤醒根，产生两次恢复")
    void twoConsecutiveRoundsEachWakeRootOnce() {
        // 第一轮。
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
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
        registry.beginRoot(ROOT_SESSION_ID);
        delegateChild(CHILD_SESSION_ID);

        // 子执行挂起等审批：保留登记、释放死线程，但父侧仍算「未结束」。
        lifecycle.onSuspended(childExecution(CHILD_SESSION_ID));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID), "等审批的子执行仍是未结束子执行");

        InterceptorResult whileWaiting = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(whileWaiting.shouldContinue(), "有等审批的子执行时根不得收尾");
        assertResumedCount(0);

        suspendRoot();

        // 审批通过并行至终态：结束事实唤醒根。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ⑥ 子执行失败 / 取消产生明确结束事实：只在最后一个终结时唤醒
    // ------------------------------------------------------------------

    @Test
    @DisplayName("⑥ 多子执行逐个失败/取消：非最后一个不唤醒，最后一个终结才唤醒根")
    void failureAndCancellationWakeRootOnlyOnLastTerminal() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateChild(CHILD_SESSION_ID);
        delegateChild(CHILD_SESSION_ID + 1);

        // 根先挂起、释放控制槽位：此后任何唤醒都会走「直接派发」（没有保留唤醒可掩护），
        // 「非最后一个子终结后仍无恢复」因此成为确定性判据，而非与异步派发赌时序。
        suspendRoot();
        assertNoResume();

        // 非最后一个子执行失败：移除登记但不唤醒（避免无谓模型轮次）。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        assertNoResume();

        // 最后一个子执行取消：明确结束事实 → 唤醒根。
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID + 1));
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        awaitResumedCount(1);
    }

    // ------------------------------------------------------------------
    // ⑤ 停止后迟到邮件：邮箱业务键是协作根会话 id，跨执行轮次仍可被消费
    // ------------------------------------------------------------------

    @Test
    @DisplayName("⑤ 停止后迟到邮件：取信键恒为协作根会话 id，下一轮执行仍能消费到")
    void lateMailAfterStopIsConsumedByNextRoundUnderRootSessionKey() {
        EmailService mailbox = mock(EmailService.class);
        AtomicReference<long[]> consumedKey = new AtomicReference<>();
        when(mailbox.consumePending(anyLong(), anyLong())).thenAnswer(invocation -> {
            consumedKey.set(new long[]{invocation.getArgument(0), invocation.getArgument(1)});
            return Result.success(List.of());
        });
        AgenticLoopInterceptor mailConsumer = new AgenticLoopInterceptor(mailbox);

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

    /** 根进入 SUSPENDED 并释放控制槽位：走真实挂起通知链（含保留唤醒重放）。 */
    private void suspendRoot() {
        rootActive.set(false);
        lifecycle.onSuspended(rootExecution());
    }

    private void delegateChild(long childSessionId) {
        registry.registerPendingChild(ROOT_SESSION_ID, childSessionId);
        registry.bindRunningChild(ROOT_SESSION_ID, childSessionId, Thread.currentThread());
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
        return new LoopContext(loopMessages, new ExecutionControlSignal(executionId), 0, appended::addAll);
    }

    private static Execution childExecution(long childSessionId) {
        return Execution.builder().id("1234")
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(childSessionId),
                                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
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
                                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                                .build())
                        .build())
                .build();
    }

    private void stubRootSummary(ExecutionState state) {
        com.summit.dp.execution.domain.model.Execution summary =
                new com.summit.dp.execution.domain.model.Execution();
        summary.setId(ROOT_EXECUTION_ID);
        summary.setSessionId(ROOT_SESSION_ID);
        summary.setStatus(ExecutionStatusCodes.encode(state));
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
}

package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 恢复协调器（{@code ExecutionResumeCoordinator}）的 worker 纪律回归。
 *
 * <p>核心不变量是「<b>恢复绝不能让已取消的执行复活</b>」。它难在时序：worker 领取任务 →
 * 释放 executionId 门闩 → 真正 resume 之前，stop 可能正好落库 CANCELLED。若恢复是无条件写，
 * 迟到的 worker 会把 CANCELLED 改回运行中，用户点了停止却停不下来。</p>
 *
 * <p><b>时序用 latch 构造而不是 sleep 赌</b>：测试在线程池外亲手执行 {@code runLoop}
 * 之前先卡住关键桩（{@code findById} 里 await 一个闸门），让「stop 落库」这一步由测试线程
 * 在确定的位置插入。观察完成同样用信号量（状态写入的桩里 countDown），不用固定 sleep。</p>
 */
class ExecutionResumeCoordinatorTest {

    private static final long EXECUTION_ID = 1000L;
    private static final long SESSION_ID = 800L;
    private static final long GENERATION = 3L;

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionAttributeRestorer sessionAttributeRestorer = mock(SessionAttributeRestorer.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionRepository frameworkExecutions = mock(ExecutionRepository.class);
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executions =
            mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);
    private final ExecutionResumeTaskRepository tasks = mock(ExecutionResumeTaskRepository.class);

    /** 恢复任务状态落库的通知：worker 线程写完就 countDown，观察端 await 它而不是 sleep。 */
    private final AtomicReference<StateWritten> stateWritten = new AtomicReference<>();
    private final AtomicReference<ExecutionResumeTask> task = new AtomicReference<>();
    /**
     * 当前任务是否仍可被领取。照抄生产 {@code claim} 的条件更新语义：同一条任务只有一方领得到。
     * 不做真实 CAS 的话，测试为绕开派发窗口而重试派发时会跑出第二个 loop，
     * 「连续多轮各恢复一次」这条断言反而变成假绿。
     */
    private final AtomicBoolean claimable = new AtomicBoolean(true);

    private ExecutionResumeCoordinator coordinator;

    @BeforeEach
    void setup() {
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(toolCallRepository,
                sessionAttributeRestorer, modelContextService, provider(executionControl));
        coordinator = new ExecutionResumeCoordinator(tasks, executions, resumer,
                provider(frameworkExecutions));

        task.set(newTask(0));
        claimable.set(true);
        when(tasks.findByExecutionId(EXECUTION_ID)).thenAnswer(invocation -> List.of(task.get()));
        when(tasks.claim(any(), any())).thenAnswer(invocation -> {
            if (!claimable.compareAndSet(true, false)) {
                return false;
            }
            ((ExecutionResumeTask) invocation.getArgument(0)).claim();
            return true;
        });
        when(tasks.updateState(any())).thenAnswer(invocation -> {
            ExecutionResumeTask written = invocation.getArgument(0);
            stateWritten.set(new StateWritten(written.getState(), written.getErrorReason(),
                    written.getNextAttemptAt()));
            return true;
        });
        when(executions.findResumeGeneration(EXECUTION_ID)).thenReturn(GENERATION);
        when(toolCallRepository.listUnresolvedByExecutionId(EXECUTION_ID)).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        coordinator.close();
    }

    // ------------------------------------------------------------------
    // 终态优先：已取消的执行绝不被恢复
    // ------------------------------------------------------------------

    @Test
    @DisplayName("执行已取消：恢复任务作废，绝不 resume")
    void cancelledExecutionIsSupersededAndNeverResumed() {
        stubStatus(ExecutionState.CANCELLED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.CANCELLED)));

        coordinator.dispatch(EXECUTION_ID);

        StateWritten written = awaitStateWritten();
        assertEquals(ResumeTaskState.SUPERSEDED, written.state(),
                "已取消的执行对应的恢复意图必须作废，不能记成失败再无限重试");
        verify(executionControl, never()).resume(any(Execution.class));
        verify(sessionAttributeRestorer, never()).restore(any(Execution.class), any());
    }

    @Test
    @DisplayName("stop 在 stale 检查之后落库：迟到的恢复按当前状态让位，不覆盖 CANCELLED")
    void stopLandingAfterStaleCheckIsNotOverwritten() {
        stubStatus(ExecutionState.SUSPENDED);
        // 卡在「锁已释放、读检查点」这一步：测试线程亲手把执行改成已取消再放行
        CountDownLatch checkpointRead = new CountDownLatch(1);
        CountDownLatch stopLanded = new CountDownLatch(1);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID))).thenAnswer(invocation -> {
            checkpointRead.countDown();
            await(stopLanded);
            return Optional.of(execution(ExecutionState.CANCELLED));
        });
        CountDownLatch workerDone = new CountDownLatch(1);
        doAnswer(invocation -> {
            ExecutionResumeTask written = invocation.getArgument(0);
            stateWritten.set(new StateWritten(written.getState(), written.getErrorReason(),
                    written.getNextAttemptAt()));
            workerDone.countDown();
            return true;
        }).when(tasks).updateState(any());

        coordinator.dispatch(EXECUTION_ID);
        await(checkpointRead);
        // stop 落库发生在 stale 检查之后、resume 之前 —— 正是必须靠「重读」兜住的窗口
        stopLanded.countDown();
        await(workerDone);

        assertEquals(ResumeTaskState.SUPERSEDED, stateWritten.get().state(),
                "stop 已落库后，迟到的恢复任务必须让位");
        verify(executionControl, never()).resume(any(Execution.class));
    }

    @Test
    @DisplayName("代际已变更：旧挂起点的恢复意图作废，不作用在新边界上")
    void staleGenerationTaskIsSuperseded() {
        stubStatus(ExecutionState.SUSPENDED);
        when(executions.findResumeGeneration(EXECUTION_ID)).thenReturn(GENERATION + 1);

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state());
        // 代际不符连检查点都不该读：读了也必然让位
        verify(frameworkExecutions, never()).findById(any());
        verify(executionControl, never()).resume(any(Execution.class));
    }

    @Test
    @DisplayName("已在运行（不在挂起态）：交给现有控制槽位，不由本 worker 重复启动")
    void runningExecutionIsSupersededInsteadOfStartedTwice() {
        stubStatus(ExecutionState.RUNNING);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.RUNNING)));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state());
        verify(executionControl, never()).resume(any(Execution.class));
    }

    // ------------------------------------------------------------------
    // 未决槽位：等待而非恢复
    // ------------------------------------------------------------------

    @Test
    @DisplayName("仍有未决槽位：退回可派发态等待，不恢复也不记失败原因")
    void unresolvedSlotRequeuesInsteadOfResuming() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(toolCallRepository.listUnresolvedByExecutionId(EXECUTION_ID))
                .thenReturn(List.of(mock(ToolCall.class)));

        coordinator.dispatch(EXECUTION_ID);

        StateWritten written = awaitStateWritten();
        assertEquals(ResumeTaskState.FAILED, written.state(), "退回可派发态等下一轮");
        assertTrue(written.retryAt() != null, "「还没到时候」必须给出退避时刻而不是记错误");
        assertNull(written.errorReason(), "等待不是错误：记失败原因会让用户以为恢复坏了");
        verify(executionControl, never()).resume(any(Execution.class));
    }

    // ------------------------------------------------------------------
    // 正常路径与失败路径
    // ------------------------------------------------------------------

    @Test
    @DisplayName("SUSPENDED 且无未决槽位：真正 resume，并补回会话属性（团队绑定不能丢）")
    void suspendedExecutionWithoutSlotsResumes() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUCCEEDED, awaitStateWritten().state());
        verify(sessionAttributeRestorer).restore(any(Execution.class), any());
        verify(executionControl).resume(any(Execution.class));
    }

    @Test
    @DisplayName("恢复失败：记 FAILED + 退避时刻并留痕，不抛出打断派发线程")
    void resumeFailureIsRecordedWithBackoff() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("loop 起不来"));

        coordinator.dispatch(EXECUTION_ID);

        StateWritten written = awaitStateWritten();
        assertEquals(ResumeTaskState.FAILED, written.state());
        assertNotNull(written.errorReason());
        assertTrue(written.errorReason().contains("loop 起不来"), "失败原因要留痕，实际=" + written.errorReason());
        assertNotNull(written.retryAt(), "未达重试上限时要给出退避时刻，由巡检再试");
    }

    @Test
    @DisplayName("重试次数达上限：不再自动重试，交给用户手工恢复")
    void exhaustedTaskStopsAutoRetry() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("loop 起不来"));
        // 逐次领取把 attempts 推到上限；最后一次派发不再给出退避时刻
        for (int attempt = 0; attempt < ExecutionResumeCoordinator.MAX_ATTEMPTS; attempt++) {
            task.get().claim();
        }
        assertTrue(task.get().exhausted(ExecutionResumeCoordinator.MAX_ATTEMPTS), "前置条件：已达上限");

        coordinator.dispatch(EXECUTION_ID);

        StateWritten written = awaitStateWritten();
        assertEquals(ResumeTaskState.EXHAUSTED, written.state(),
                "耗尽的字面量状态必须与「退避未到点的 FAILED」可区分，否则会被 listDispatchable 反复选中");
        assertNull(written.retryAt(), "达上限后不再自动重试，否则会无限刷失败");
    }

    @Test
    @DisplayName("领取失败（已被另一 worker 领走）：本 worker 让位，绝不跑第二个 loop")
    void failedClaimYieldsToOtherWorker() {
        // 覆盖领取桩必须用 doReturn：when(...) 的注册期会真实调用 claim(null, ...)
        doReturn(false).when(tasks).claim(any(), any());
        stubStatus(ExecutionState.SUSPENDED);

        coordinator.dispatch(EXECUTION_ID);

        verify(frameworkExecutions, never()).findById(any());
        verify(executionControl, never()).resume(any(Execution.class));
        assertNull(stateWritten.get(), "领取失败时任务归另一 worker，本 worker 不写任何状态");
    }

    // ------------------------------------------------------------------
    // 派发门闩的回收
    // ------------------------------------------------------------------

    @Test
    @DisplayName("派发结束后门闩条目被回收：map 不随历史执行数线性增长")
    void dispatchGateIsRecycledAfterRun() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        // 连跑三次。若门闩条目用完不删，第二轮会被 CAS 挡住而永远不派发。
        for (int round = 0; round < 3; round++) {
            task.set(newTask(round));
            claimable.set(true);
            stateWritten.set(null);

            assertEquals(ResumeTaskState.SUCCEEDED, dispatchAndAwaitState().state(),
                    "第 " + (round + 1) + " 轮应正常派发并恢复");
        }

        // claim 桩是真 CAS：三轮各恢复一次，不会有多跑出来的 loop
        verify(executionControl, times(3)).resume(any(Execution.class));
    }

    private ExecutionResumeTask newTask(long seq) {
        return ExecutionResumeTask.builder().id(seq + 1).executionId(EXECUTION_ID)
                .generation(GENERATION).state(ResumeTaskState.READY).attempts(0).version(1L)
                .nextAttemptAt(Instant.now()).createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    // ------------------------------------------------------------------
    // 等待与构桩
    // ------------------------------------------------------------------

    private void stubStatus(ExecutionState state) {
        com.summit.dp.execution.domain.model.Execution summary =
                new com.summit.dp.execution.domain.model.Execution();
        summary.setId(EXECUTION_ID);
        summary.setSessionId(SESSION_ID);
        summary.setStatus(ExecutionStatusCodes.encode(state));
        summary.setResumeGeneration(GENERATION);
        when(executions.findSummariesByIds(any())).thenReturn(List.of(summary));
    }

    /**
     * 派发并等这一轮的状态落库；被门闩挡下就重试。
     *
     * <p><b>为什么允许重试派发</b>：观察点（状态写入）发生在 worker 的 {@code finally} 之前，
     * 而门闩正是在 {@code finally} 里释放 —— 观察到状态的那一刻门闩可能还没放掉，下一次
     * {@code dispatch} 会被 CAS 吞掉。这不是缺陷：生产里同样由巡检重投，语义一致。
     * 用「重投直到落库」而不是 sleep 来对齐，避免把时序假设写进断言。</p>
     */
    private StateWritten dispatchAndAwaitState() {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            coordinator.dispatch(EXECUTION_ID);
            if (stateWritten.get() != null) {
                return stateWritten.get();
            }
            Thread.onSpinWait();
        }
        throw new AssertionError("5 秒内没有观察到恢复任务状态写入");
    }

    /** 阻塞到 worker 写完状态；观察端靠它同步，不用固定 sleep 赌。 */
    private StateWritten awaitStateWritten() {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            StateWritten written = stateWritten.get();
            if (written != null) {
                return written;
            }
            Thread.onSpinWait();
        }
        throw new AssertionError("5 秒内没有观察到恢复任务状态写入");
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw new AssertionError("等待闸门超时");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("等待被中断", e);
        }
    }

    private Execution execution(ExecutionState state) {
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).executionState(state)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID)))
                                .build())
                        .build())
                .build();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }

    /** 一次状态落库的快照：断言需要状态、失败原因、退避时刻三者，缺一不可。 */
    private record StateWritten(ResumeTaskState state, String errorReason, Instant retryAt) {
    }
}

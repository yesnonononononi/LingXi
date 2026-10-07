package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
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
 * <p>核心不变量是「<b>恢复只尝试一次，且绝不把竞争失败判成执行失败</b>」。它难在时序：
 * worker 领取请求 → 释放 executionId 门闩 → 真正 resume 之前，stop 可能正好落库 CANCELLED，
 * 或另一条 loop 已抢占控制槽位；异常抛出后若不加区分地收口，会把一次正常的竞争/让位
 * 错记成执行失败。</p>
 *
 * <p><b>时序用 latch 构造而不是 sleep 赌</b>：测试在线程池外亲手执行 {@code runOnce}
 * 之前先卡住关键桩，让「stop 落库」「loop 已跑完」这类事件由测试线程在确定的位置插入。
 * 观察完成同样用信号量（状态写入的桩里 countDown），不用固定 sleep。</p>
 */
class ExecutionResumeCoordinatorTest {

    private static final long EXECUTION_ID = 1000L;
    private static final long SESSION_ID = 800L;
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

    /** 恢复请求状态落库的通知：worker 线程写完就 countDown，观察端 await 它而不是 sleep。 */
    private final AtomicReference<StateWritten> stateWritten = new AtomicReference<>();
    private final AtomicReference<ExecutionResumeTask> task = new AtomicReference<>();
    /** 照抄生产 {@code claim} 的条件更新语义：同一条请求只有一方领得到。 */
    private final AtomicBoolean claimable = new AtomicBoolean(true);
    /** worker 每次读请求列表记一次；用来确认「上一个 worker 已退出、门闩已回收」。 */
    private final AtomicInteger dispatchReads = new AtomicInteger();

    private ExecutionResumeCoordinator coordinator;

    @BeforeEach
    void setup() {
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(toolCallRepository,
                sessionAttributeRestorer, modelContextService, provider(executionControl));
        coordinator = new ExecutionResumeCoordinator(tasks, executions, resumer, executionControl,
                provider(frameworkExecutions), provider(activity));

        task.set(newTask(0));
        claimable.set(true);
        when(activity.isActive(any())).thenReturn(false);
        when(executionControl.fail(any(), any())).thenReturn(() -> { });
        when(tasks.findByExecutionId(EXECUTION_ID)).thenAnswer(invocation -> {
            dispatchReads.incrementAndGet();
            return List.of(task.get());
        });
        when(tasks.claim(any())).thenAnswer(invocation -> {
            if (!claimable.compareAndSet(true, false)) {
                return false;
            }
            ((ExecutionResumeTask) invocation.getArgument(0)).claim();
            return true;
        });
        when(tasks.updateState(any())).thenAnswer(invocation -> {
            ExecutionResumeTask written = invocation.getArgument(0);
            stateWritten.set(new StateWritten(written.getState(), written.getErrorReason()));
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
    @DisplayName("执行已取消：恢复请求作废，绝不 resume")
    void cancelledExecutionIsSupersededAndNeverResumed() {
        stubStatus(ExecutionState.CANCELLED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.CANCELLED)));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state(),
                "已取消的执行对应的恢复请求必须作废，不能记成失败");
        verify(executionControl, never()).resume(any(Execution.class));
        verify(executionControl, never()).fail(any(), any());
        verify(sessionAttributeRestorer, never()).restore(any(Execution.class), any());
    }

    @Test
    @DisplayName("stop 在 stale 检查之后落库：迟到的恢复按当前状态让位，不覆盖 CANCELLED")
    void stopLandingAfterStaleCheckIsNotOverwritten() {
        stubStatus(ExecutionState.SUSPENDED);
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
            stateWritten.set(new StateWritten(written.getState(), written.getErrorReason()));
            workerDone.countDown();
            return true;
        }).when(tasks).updateState(any());

        coordinator.dispatch(EXECUTION_ID);
        await(checkpointRead);
        // stop 落库发生在 stale 检查之后、resume 之前 —— 正是必须靠「重读」兜住的窗口
        stopLanded.countDown();
        await(workerDone);

        assertEquals(ResumeTaskState.SUPERSEDED, stateWritten.get().state(),
                "stop 已落库后，迟到的恢复请求必须让位");
        verify(executionControl, never()).resume(any(Execution.class));
    }

    @Test
    @DisplayName("代际已变更：旧挂起点的恢复请求作废，不作用在新边界上")
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
    // 竞争失败不判执行失败（变异守卫 #1）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("控制槽位已被占用：让位，绝不把竞争失败判成执行失败")
    void activeControlSlotYieldsWithoutFailingExecution() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        // 另一条 loop 已持有该执行的控制槽位：本次让位，不是启动失败。
        when(activity.isActive(String.valueOf(EXECUTION_ID))).thenReturn(true);

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state(),
                "控制槽位被占用属于竞争失败，请求作废即可，绝不记成 FAILED");
        verify(executionControl, never()).resume(any(Execution.class));
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("起步前控制槽位被抢占（resume 抛异常）：让位，绝不把竞争失败判成执行失败")
    void raceLostBeforeStartupYieldsWithoutFailingExecution() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        // 起步前检查：无活跃 loop；resume 抛异常后重查：已被另一条 loop 抢占控制槽位。
        when(activity.isActive(String.valueOf(EXECUTION_ID))).thenReturn(false).thenReturn(true);
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("执行已在运行"));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state(),
                "控制槽位已被抢占属于竞争失败，绝不改判为启动失败");
        verify(executionControl, never()).fail(any(), any());
    }

    // ------------------------------------------------------------------
    // loop 已跑完、回写异常不得覆盖终态（变异守卫 #2）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("loop 已跑完、仅回写异常：执行已终态，请求作废且不收口")
    void completedLoopWithWriteBackFailureMustNotBeReclassifiedAsStartupFailure() {
        stubStatus(ExecutionState.SUSPENDED);
        // 首次读：挂起（worker 决定恢复）；异常后重读：已 COMPLETED（loop 跑完了，只是回写抛了）
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)))
                .thenReturn(Optional.of(execution(ExecutionState.COMPLETED)));
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("回写模型上下文失败"));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten().state(),
                "loop 已跑完、异常发生在回写阶段：绝不能覆盖终态、也不得改判为启动失败");
        verify(executionControl, never()).fail(any(), any());
    }

    // ------------------------------------------------------------------
    // 真正的启动失败：收口执行 + 记失败（且只尝试一次）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("真正启动失败（仍挂起且无控制槽位）：收口执行并记失败，只尝试一次")
    void genuineStartupFailureClosesExecutionAndRecordsFailure() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("loop 起不来"));

        coordinator.dispatch(EXECUTION_ID);

        StateWritten written = awaitStateWritten();
        assertEquals(ResumeTaskState.FAILED, written.state(), "启动失败必须收口为 FAILED");
        assertNotNull(written.errorReason());
        assertTrue(written.errorReason().contains("loop 起不来"), "失败原因要留痕，实际=" + written.errorReason());
        // 执行按框架失败链收口（终态 + 轮次 + 事件都在框架里）。
        verify(executionControl).fail(any(Execution.class), any());
        // 只尝试一次：没有重试，resume 只被调用一次。
        verify(executionControl, times(1)).resume(any(Execution.class));
    }

    @Test
    @DisplayName("关闭导致的中断：不是启动失败，请求留在未完成态、不收口")
    void interruptDuringResumeDoesNotWriteTerminalState() {
        stubStatus(ExecutionState.SUSPENDED);
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class))).thenAnswer(invocation -> {
            // 模拟关闭打断：worker 线程被 interrupt 后抛出。
            Thread.currentThread().interrupt();
            throw new IllegalStateException("closed");
        });

        coordinator.dispatch(EXECUTION_ID);
        awaitWorkerQuiescent();

        StateWritten written = stateWritten.get();
        assertTrue(written == null || written.state() != ResumeTaskState.FAILED,
                "关闭中断不是启动失败：落 FAILED 会把一条本可收口的请求改判，实际=" + written);
        verify(executionControl, never()).fail(any(), any());
    }

    // ------------------------------------------------------------------
    // 正常路径
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
    @DisplayName("领取失败（已被另一 worker 领走）：本 worker 让位，绝不跑第二个 loop")
    void failedClaimYieldsToOtherWorker() {
        doReturn(false).when(tasks).claim(any());
        stubStatus(ExecutionState.SUSPENDED);

        coordinator.dispatch(EXECUTION_ID);

        verify(frameworkExecutions, never()).findById(any());
        verify(executionControl, never()).resume(any(Execution.class));
        assertNull(stateWritten.get(), "领取失败时请求归另一 worker，本 worker 不写任何状态");
    }

    // ------------------------------------------------------------------
    // accept：落请求 + 提交后派发
    // ------------------------------------------------------------------

    @Test
    @DisplayName("accept：无未决槽位则落请求并排到提交后派发，最终恢复")
    void acceptWritesMarkerAndSchedulesDispatchAfterCommit() {
        stubStatus(ExecutionState.SUSPENDED);
        when(tasks.enqueue(anyLong(), anyLong(), any())).thenReturn(task.get());
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));
        when(executionControl.resume(any(Execution.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));
        // 无事务同步时立即执行派发（真实 LocalExecutionRepository 的同款降级语义）。
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(frameworkExecutions).afterCommit(any());

        ResumeDisposition disposition = coordinator.accept(EXECUTION_ID);

        assertEquals(ResumeDisposition.QUEUED, disposition);
        assertEquals(ResumeTaskState.SUCCEEDED, awaitStateWritten().state());
        verify(tasks).enqueue(eq(EXECUTION_ID), eq(GENERATION), any());
        verify(frameworkExecutions).afterCommit(any());
    }

    @Test
    @DisplayName("accept：仍有未决槽位则不落请求、不派发，交最后一个槽位触发")
    void acceptWithUnresolvedSlotWaitsWithoutMarker() {
        stubStatus(ExecutionState.SUSPENDED);
        when(toolCallRepository.listUnresolvedByExecutionId(EXECUTION_ID))
                .thenReturn(List.of(mock(ToolCall.class)));

        ResumeDisposition disposition = coordinator.accept(EXECUTION_ID);

        assertEquals(ResumeDisposition.WAITING_OTHER_TOOLS, disposition);
        verify(tasks, never()).enqueue(anyLong(), anyLong(), any());
        verify(frameworkExecutions, never()).afterCommit(any());
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

        verify(executionControl, times(3)).resume(any(Execution.class));
    }

    private ExecutionResumeTask newTask(long seq) {
        return ExecutionResumeTask.builder().id(seq + 1).executionId(EXECUTION_ID)
                .generation(GENERATION).state(ResumeTaskState.READY).version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
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
     * {@code dispatch} 会被 CAS 吞掉。用「重投直到落库」而不是 sleep 来对齐。</p>
     */
    private StateWritten dispatchAndAwaitState() {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(AWAIT_TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            coordinator.dispatch(EXECUTION_ID);
            if (stateWritten.get() != null) {
                return stateWritten.get();
            }
            Thread.onSpinWait();
        }
        throw new AssertionError(AWAIT_TIMEOUT_SECONDS + " 秒内没有观察到恢复请求状态写入");
    }

    /** 阻塞到 worker 写完状态；观察端靠它同步，不用固定 sleep 赌。 */
    private StateWritten awaitStateWritten() {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(AWAIT_TIMEOUT_SECONDS);
        while (System.nanoTime() < deadline) {
            StateWritten written = stateWritten.get();
            if (written != null) {
                return written;
            }
            Thread.onSpinWait();
        }
        throw new AssertionError(AWAIT_TIMEOUT_SECONDS + " 秒内没有观察到恢复请求状态写入");
    }

    /**
     * 等到「上一个 worker 已退出」：反复派发，直到新 worker 再次读到请求列表。
     *
     * <p><b>为什么必须等</b>：让位/中断路径若被误当异常，其副作用可能晚于观察点发生；
     * 只有确认前一个 worker 已释放门闩，这类「没有第二次尝试」的断言才成立。</p>
     */
    private void awaitWorkerQuiescent() {
        int nextRead = dispatchReads.get() + 1;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(AWAIT_TIMEOUT_SECONDS);
        while (dispatchReads.get() < nextRead) {
            coordinator.dispatch(EXECUTION_ID);
            if (System.nanoTime() >= deadline) {
                throw new AssertionError("未观察到上一个 worker 退出（门闩未回收）");
            }
            Thread.onSpinWait();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(AWAIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
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

    /** 一次状态落库的快照：断言需要状态与失败原因两者。 */
    private record StateWritten(ResumeTaskState state, String errorReason) {
    }
}

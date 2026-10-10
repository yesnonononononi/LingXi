package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionTarget;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.ArgumentMatchers;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 交付总监独立验证（QA 严过关）—— 注册线程落点 / 取消传播 / 异常兜底的对抗性用例。
 *
 * <p>盯两点：① 绑定的落点是「<b>真正跑子 loop 的那根异步线程</b>」，而不是恰好等于调用线程；
 * ② 「取消前即失败」时不得产生任何孤儿（会话行 / 子轮次 / 执行行 / 幽灵注册条目）。</p>
 */
class QaAsyncDelegationSubmitterAdversarialTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_SESSION_ID = 555L;
    private static final long PARENT_WS_ID = 66L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long CHILD_AGENT_ID = 7L;

    private final SubAgent subAgent = mock(SubAgent.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final SubSessionResolver subSessionResolver = mock(SubSessionResolver.class);
    private final DelegationRecorder delegationRecorder = mock(DelegationRecorder.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final SubExecutionLifecycle subExecutionLifecycle = mock(SubExecutionLifecycle.class);

    private final AsyncDelegationSubmitter submitter = new AsyncDelegationSubmitter(subAgent, registry,
            subSessionResolver, delegationRecorder, modelContextService, executionControl, subExecutionLifecycle);

    private AsyncDelegationTask task(SubSessionTarget target) {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setTask("子任务");
        ToolExecution toolExecution = mock(ToolExecution.class);
        com.summit.core.agent.AgentRequest request = mock(com.summit.core.agent.AgentRequest.class);
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        return new AsyncDelegationTask(ROOT_SESSION_ID, CHILD_SESSION_ID, PARENT_WS_ID, ROOT_EXECUTION_ID, target,
                agent, argument, toolExecution, request);
    }

    @Test
    @DisplayName("对抗：绑定对象 = 真正跑子 loop 的异步线程（独立于调用线程）")
    void bindsTheActualLoopThreadNotCallerThread() {
        // 换一个在「新线程」上执行的执行器：调用线程 ≠ 子 loop 线程，从而能区分二者。
        ReflectionTestUtils.setField(submitter, "executorService", new NewThreadExecutorService());

        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        Execution executed = mock(Execution.class);
        when(executed.getMessages()).thenReturn(List.of(UserMessageEntity.from("ok")));
        when(subAgent.createExecution(task.request())).thenReturn(created);

        AtomicReference<Thread> loopThread = new AtomicReference<>();
        when(subAgent.execute(created)).thenAnswer(invocation -> {
            loopThread.set(Thread.currentThread());
            return executed;
        });

        Thread callerThread = Thread.currentThread();
        submitter.submit(task); // NewThreadExecutor 内 start+join，返回时 runChild 已跑完

        ArgumentCaptor<Thread> threadCaptor = ArgumentCaptor.forClass(Thread.class);
        verify(registry).bindRunningChild(ArgumentMatchers.eq(ROOT_SESSION_ID),
                ArgumentMatchers.eq(CHILD_SESSION_ID), threadCaptor.capture());

        assertEquals(loopThread.get(), threadCaptor.getValue(),
                "绑定进注册表的必须是跑子 loop 的那根线程（interrupt 才打得到）");
        assertNotEquals(callerThread, threadCaptor.getValue(),
                "绑定对象不应是工具调用线程 —— 否则停止会打断错误的线程");
    }

    @Test
    @DisplayName("对抗：绑定前即取消 → 零落库、零注册残留、零兜底唤醒")
    void cancelBeforeBindingProducesNoOrphan() {
        ReflectionTestUtils.setField(submitter, "executorService", new NewThreadExecutorService());

        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));
        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(false);

        submitter.submit(task);

        // 孤儿三问：会话行？子轮次？执行行？—— 全不建。
        verify(subSessionResolver, never()).createSubSession(any(), any(), any(), any(), any());
        verify(delegationRecorder, never()).record(any(), any(), any(), any(), any(), any(), any());
        verify(subAgent, never()).createExecution(any());
        verify(subAgent, never()).execute(any(Execution.class));

        // 绑定失败 → 撤销待启动登记，不该去注销别人的条目，也不该兜底唤醒。
        verify(registry).revokeChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(registry, never()).unregisterChild(any(), any());
        verify(subExecutionLifecycle, never()).abandonChild(any(), any(), any());
        verify(registry, never()).beginRoot(any());
        verify(registry, never()).finishRoot(any());
        verify(executionControl, never()).fail(any(Execution.class), any());
    }

    @Test
    @DisplayName("对抗：子 loop 抛异常 → 结束事实兜底、回写不发生、根资格与会话行不残留")
    void exceptionCleanupLeavesNoGhostAndTouchesNoRootToken() {
        ReflectionTestUtils.setField(submitter, "executorService", new NewThreadExecutorService());

        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));
        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        when(created.getExecutionState()).thenReturn(ExecutionState.RUNNING);
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenThrow(new IllegalStateException("qa: 子 loop 崩了"));

        submitter.submit(task);

        verify(subExecutionLifecycle).abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);
        verify(registry, never()).beginRoot(any());
        verify(registry, never()).finishRoot(any());
        verify(modelContextService, never()).replace(any(), any());
        // 已开跑的失败由框架收口，业务侧不得重复 fail。
        verify(executionControl, never()).fail(any(Execution.class), any());
    }

    /** 每次提交都在一根全新线程上执行并 join：让调用线程与子 loop 线程可区分。 */
    private static final class NewThreadExecutorService extends AbstractExecutorService {
        @Override
        public void execute(Runnable command) {
            Thread thread = new Thread(command, "qa-async-child");
            thread.start();
            try {
                thread.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public void shutdown() {
        }

        @Override
        public java.util.List<Runnable> shutdownNow() {
            return java.util.List.of();
        }

        @Override
        public boolean isShutdown() {
            return false;
        }

        @Override
        public boolean isTerminated() {
            return false;
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return true;
        }
    }
}

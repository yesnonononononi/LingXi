package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
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
import org.mockito.InOrder;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 协作式子执行的注册 / 收尾契约。
 *
 * <p>只盯两件事：① 注册对象是<b>该异步线程自身</b>、且绑定<b>先于</b>全部落库与开跑动作；
 * ② 终止登记不再挂在异步线程的 finally —— 子执行「未结束」由结束事实链（{@code SubExecutionLifecycle}）
 * 处理；只有「落库前失败」这类从未建立执行的场景才由本类兜底唤醒。全程不碰根运行资格
 * （{@code beginRoot} / {@code finishRoot} 一次都不调）。</p>
 */
class AsyncDelegationSubmitterTest {

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

    AsyncDelegationSubmitterTest() {
        // 同线程执行：让提交与 runChild 在测试线程内同步跑完，既可断言顺序也可断言绑定线程。
        ReflectionTestUtils.setField(submitter, "executorService", new InlineExecutorService());
        when(executionControl.fail(any(Execution.class), any())).thenReturn(() -> { });
    }

    private AsyncDelegationTask task(SubSessionTarget target) {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setTask("子任务");
        ToolExecution toolExecution = mock(ToolExecution.class);
        AgentRequest request = mock(AgentRequest.class);
        AgentVO agent = new AgentVO();
        agent.setId(CHILD_AGENT_ID);
        agent.setName("架构师");
        return new AsyncDelegationTask(ROOT_SESSION_ID, CHILD_SESSION_ID, PARENT_WS_ID, ROOT_EXECUTION_ID, target,
                agent, argument, toolExecution, request);
    }

    private Execution completedExecution(List<Message> messages) {
        Execution execution = mock(Execution.class);
        when(execution.getMessages()).thenReturn(messages);
        return execution;
    }

    @Test
    @DisplayName("正常路径：先绑定（对象=当前线程）→ 建行 → 落账 → 建执行 → 开跑 → 回写，全程不碰根资格、不主动注销")
    void bindsBeforeRunningAndDoesNotUnregisterOnSuccess() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.bindRunningChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread())).thenReturn(true);
        Execution created = mock(Execution.class);
        Execution executed = completedExecution(List.of(UserMessageEntity.from("好的")));
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenReturn(executed);

        submitter.submit(task);

        // 绑定对象 = 跑子 loop 的那根线程（同一线程执行体下即当前线程）。
        verify(registry).bindRunningChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread());

        // 顺序不可倒置：绑定 → 建行 → 落账 → 建执行 → 开跑 → 回写。
        InOrder order = inOrder(registry, subSessionResolver, delegationRecorder, subAgent, modelContextService);
        order.verify(registry).bindRunningChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread());
        order.verify(subSessionResolver).createSubSession(eq(CHILD_SESSION_ID), eq(ROOT_SESSION_ID), eq(PARENT_WS_ID),
                any(AgentVO.class), eq("子任务"));
        order.verify(delegationRecorder).record(eq(ROOT_SESSION_ID), any(ToolExecution.class), eq(task.request()),
                eq(CHILD_SESSION_ID), eq(String.valueOf(CHILD_SESSION_ID)), any(AgentVO.class), eq("子任务"));
        order.verify(subAgent).createExecution(task.request());
        order.verify(subAgent).execute(created);
        order.verify(modelContextService).replace(CHILD_SESSION_ID, executed.getMessages());

        // 成功终态由结束事实链移除登记；本类不再在 finally 注销，也不兜底唤醒。
        verify(registry, never()).unregisterChild(any(), any());
        verify(subExecutionLifecycle, never()).abandonChild(any(), any(), any());
        // 根运行资格绝不被子执行误释放（否则根会「提前收尾」）。
        verify(registry, never()).beginRoot(any());
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("复用子会话：不重复建会话行，但仍落账与开跑")
    void reusedSubSessionSkipsRowCreation() {
        SubSessionTarget target = SubSessionTarget.reused(String.valueOf(CHILD_SESSION_ID), List.of());
        AsyncDelegationTask task = task(target);

        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        Execution executed = completedExecution(List.of());
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenReturn(executed);

        submitter.submit(task);

        verify(subSessionResolver, never()).createSubSession(any(), any(), any(), any(), any());
        verify(delegationRecorder).record(eq(ROOT_SESSION_ID), any(ToolExecution.class), eq(task.request()),
                eq(CHILD_SESSION_ID), any(), any(AgentVO.class), any());
        verify(modelContextService).replace(CHILD_SESSION_ID, executed.getMessages());
        verify(subExecutionLifecycle, never()).abandonChild(any(), any(), any());
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("取消前不起跑：绑定失败即撤销待启动登记、不建任何行、不开跑、不兜底唤醒")
    void cancelBeforeStartCreatesNothing() {
        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));

        when(registry.bindRunningChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread())).thenReturn(false);

        submitter.submit(task);

        verify(registry).revokeChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(subSessionResolver, never()).createSubSession(any(), any(), any(), any(), any());
        verify(delegationRecorder, never()).record(any(), any(), any(), any(), any(), any(), any());
        verify(subAgent, never()).createExecution(any());
        verify(subAgent, never()).execute(any(Execution.class));
        verify(subExecutionLifecycle, never()).abandonChild(any(), any(), any());
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("异常收尾：子 loop 抛异常后走结束事实兜底、且不误释放根资格、不回写上下文")
    void abandonOnFailureWithoutReleasingRootToken() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        when(created.getExecutionState()).thenReturn(ExecutionState.RUNNING);
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenThrow(new IllegalStateException("子 loop 崩了"));

        submitter.submit(task);

        verify(subExecutionLifecycle).abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);
        verify(registry, never()).finishRoot(any());
        verify(modelContextService, never()).replace(any(), any());
        // 已开跑（RUNNING）的失败由框架收口，业务侧不得重复 fail（会抛非法状态转换）。
        verify(executionControl, never()).fail(any(Execution.class), any());
    }

    @Test
    @DisplayName("未开跑即中止：执行仍是 CREATED 时由业务侧补收口 fail，并走结束事实兜底")
    void failsCreatedExecutionThatNeverRan() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        when(created.getExecutionState()).thenReturn(ExecutionState.CREATED);
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenThrow(new IllegalStateException("开跑即失败"));

        submitter.submit(task);

        verify(executionControl).fail(eq(created), any(IllegalStateException.class));
        verify(subExecutionLifecycle).abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("落库阶段就失败：无执行可收口，但结束事实兜底仍唤醒根")
    void failureBeforeExecutionCreationStillAbandons() {
        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));

        when(registry.bindRunningChild(anyLong(), anyLong(), any())).thenReturn(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("建会话行失败"))
                .when(subSessionResolver).createSubSession(any(), any(), any(), any(), any());

        submitter.submit(task);

        verify(executionControl, never()).fail(any(Execution.class), any());
        verify(subAgent, never()).createExecution(any());
        verify(subExecutionLifecycle).abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("close() 停掉子执行线程池（避免线程泄漏）")
    void closeStopsExecutor() {
        ReflectionTestUtils.setField(submitter, "executorService", java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        submitter.close();
        Object pool = ReflectionTestUtils.getField(submitter, "executorService");
        assertEquals(true, ((java.util.concurrent.ExecutorService) pool).isShutdown());
    }

    /** 同线程执行器：让 submit() 在调用线程内同步跑完 runChild。 */
    private static final class InlineExecutorService extends AbstractExecutorService {
        @Override
        public void execute(Runnable command) {
            command.run();
        }

        @Override
        public void shutdown() {
        }

        @Override
        public List<Runnable> shutdownNow() {
            return List.of();
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

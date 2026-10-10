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
 * 协作式子执行的注册 / 收尾契约（AC-7 / AC-8）。
 *
 * <p>只盯两件事：① 注册对象是<b>该异步线程自身</b>、且注册<b>先于</b>全部落库与开跑动作；
 * ② 三条收尾路径（未开跑 / 正常 / 异常）都不残留幽灵条目，且<b>全程不碰根运行资格</b>
 * （{@code beginRoot} / {@code finishRoot} 一次都不调）—— 这正是「不复用 PreparedChatExecutor」的理由。</p>
 */
class AsyncDelegationSubmitterTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_SESSION_ID = 555L;
    private static final long PARENT_WS_ID = 66L;
    private static final long CHILD_AGENT_ID = 7L;

    private final SubAgent subAgent = mock(SubAgent.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final SubSessionResolver subSessionResolver = mock(SubSessionResolver.class);
    private final DelegationRecorder delegationRecorder = mock(DelegationRecorder.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);

    private final AsyncDelegationSubmitter submitter = new AsyncDelegationSubmitter(subAgent, registry,
            subSessionResolver, delegationRecorder, modelContextService, executionControl);

    AsyncDelegationSubmitterTest() {
        // 同线程执行：让提交与 runChild 在测试线程内同步跑完，既可断言顺序也可断言注册线程。
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
        return new AsyncDelegationTask(ROOT_SESSION_ID, CHILD_SESSION_ID, PARENT_WS_ID, target, agent,
                argument, toolExecution, request);
    }

    private Execution completedExecution(List<Message> messages) {
        Execution execution = mock(Execution.class);
        when(execution.getMessages()).thenReturn(messages);
        return execution;
    }

    @Test
    @DisplayName("AC-8 正常路径：先注册（对象=当前线程）→ 建行 → 落账 → 建执行 → 开跑 → 注销，全程不碰根资格")
    void registersBeforeRunningAndUnregistersAfter() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.registerChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread())).thenReturn(true);
        Execution created = mock(Execution.class);
        Execution executed = completedExecution(List.of(UserMessageEntity.from("好的")));
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenReturn(executed);

        submitter.submit(task);

        // 注册对象 = 跑子 loop 的那根线程（同一线程执行体下即当前线程）。
        verify(registry).registerChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread());

        // 顺序不可倒置：注册 → 建行 → 落账 → 建执行 → 开跑 → 回写 → 注销。
        InOrder order = inOrder(registry, subSessionResolver, delegationRecorder, subAgent, modelContextService);
        order.verify(registry).registerChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread());
        order.verify(subSessionResolver).createSubSession(eq(CHILD_SESSION_ID), eq(ROOT_SESSION_ID), eq(PARENT_WS_ID),
                any(AgentVO.class), eq("子任务"));
        order.verify(delegationRecorder).record(eq(ROOT_SESSION_ID), any(ToolExecution.class), eq(task.request()),
                eq(CHILD_SESSION_ID), eq(String.valueOf(CHILD_SESSION_ID)), any(AgentVO.class), eq("子任务"));
        order.verify(subAgent).createExecution(task.request());
        order.verify(subAgent).execute(created);
        order.verify(modelContextService).replace(CHILD_SESSION_ID, executed.getMessages());
        order.verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);

        // 根运行资格绝不被子执行误释放（否则根会「提前收尾」）。
        verify(registry, never()).beginRoot(any());
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("复用子会话：不重复建会话行，但仍落账与开跑")
    void reusedSubSessionSkipsRowCreation() {
        SubSessionTarget target = SubSessionTarget.reused(String.valueOf(CHILD_SESSION_ID), List.of());
        AsyncDelegationTask task = task(target);

        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        Execution executed = completedExecution(List.of());
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenReturn(executed);

        submitter.submit(task);

        verify(subSessionResolver, never()).createSubSession(any(), any(), any(), any(), any());
        verify(delegationRecorder).record(eq(ROOT_SESSION_ID), any(ToolExecution.class), eq(task.request()),
                eq(CHILD_SESSION_ID), any(), any(AgentVO.class), any());
        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("AC-7 取消前不起跑：注册失败即不建任何行、不开跑、不注销（无孤儿、无幽灵条目）")
    void cancelBeforeStartCreatesNothing() {
        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));

        when(registry.registerChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread())).thenReturn(false);

        submitter.submit(task);

        verify(subSessionResolver, never()).createSubSession(any(), any(), any(), any(), any());
        verify(delegationRecorder, never()).record(any(), any(), any(), any(), any(), any(), any());
        verify(subAgent, never()).createExecution(any());
        verify(subAgent, never()).execute(any(Execution.class));
        verify(registry, never()).unregisterChild(any(), any());
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("AC-8 异常收尾：子 loop 抛异常后仍注销、且不误释放根资格、不回写上下文")
    void unregistersOnFailureWithoutReleasingRootToken() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        when(created.getExecutionState()).thenReturn(ExecutionState.RUNNING);
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenThrow(new IllegalStateException("子 loop 崩了"));

        submitter.submit(task);

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(registry, never()).finishRoot(any());
        verify(modelContextService, never()).replace(any(), any());
        // 已开跑（RUNNING）的失败由框架收口，业务侧不得重复 fail（会抛非法状态转换）。
        verify(executionControl, never()).fail(any(Execution.class), any());
    }

    @Test
    @DisplayName("AC-8 未开跑即中止：执行仍是 CREATED 时由业务侧补收口 fail，并注销")
    void failsCreatedExecutionThatNeverRan() {
        SubSessionTarget target = SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID));
        AsyncDelegationTask task = task(target);

        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        Execution created = mock(Execution.class);
        when(created.getExecutionState()).thenReturn(ExecutionState.CREATED);
        when(subAgent.createExecution(task.request())).thenReturn(created);
        when(subAgent.execute(created)).thenThrow(new IllegalStateException("开跑即失败"));

        submitter.submit(task);

        verify(executionControl).fail(eq(created), any(IllegalStateException.class));
        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(registry, never()).finishRoot(any());
    }

    @Test
    @DisplayName("落库阶段就失败：无执行可收口，但 finally 仍注销")
    void failureBeforeExecutionCreationStillUnregisters() {
        AsyncDelegationTask task = task(SubSessionTarget.fresh(String.valueOf(CHILD_SESSION_ID)));

        when(registry.registerChild(anyLong(), anyLong(), any())).thenReturn(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("建会话行失败"))
                .when(subSessionResolver).createSubSession(any(), any(), any(), any(), any());

        submitter.submit(task);

        verify(executionControl, never()).fail(any(Execution.class), any());
        verify(subAgent, never()).createExecution(any());
        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
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

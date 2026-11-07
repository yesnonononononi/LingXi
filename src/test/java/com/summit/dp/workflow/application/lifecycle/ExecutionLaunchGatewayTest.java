package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 统一启动入口的行为守卫：准入、提交、没能起步的收口都只写一遍。
 *
 * <p>这里守的是「两条启动链真的共用一个入口」—— 有人把根或子改回各自直连时，本类的用例
 * 必须变红；否则「统一」只是一句注释。</p>
 */
class ExecutionLaunchGatewayTest {

    private final StartupFailureCloser closer = mock(StartupFailureCloser.class);
    private final ExecutionLaunchGateway gateway = new ExecutionLaunchGateway(closer);

    @Test
    @DisplayName("线程池拒绝提交：按角色收口并撤销登记，异常原样抛出")
    void rejectedSubmitClosesByRoleAndReleasesRegistration() {
        ExecutorService rejecting = rejectingExecutor();
        Execution execution = execution("9301");
        List<String> released = new ArrayList<>();

        RejectedExecutionException thrown = assertThrows(RejectedExecutionException.class,
                () -> gateway.submit(spec(ExecutionLaunchRole.ROOT, rejecting, execution, () -> true,
                        () -> released.add("finishRoot"), () -> { })));

        // 拒绝原因由 JDK 拼装（含被拒任务描述），只断言类型与收口口径，不钉死文案。
        verify(closer).closeQuietly(execution, thrown, ExecutionLaunchRole.ROOT);
        assertEquals(List.of("finishRoot"), released,
                "拒绝意味着异步体永远不会执行，登记只能在这里撤销，否则会话被单飞锁死");
    }

    @Test
    @DisplayName("子代理角色被拒：走 SB_AGENT 口径，且不碰根运行资格")
    void rejectedChildSubmitUsesChildRole() {
        ExecutorService rejecting = rejectingExecutor();
        List<String> released = new ArrayList<>();

        assertThrows(RejectedExecutionException.class,
                () -> gateway.submit(spec(ExecutionLaunchRole.SUB_AGENT, rejecting, null, () -> true,
                        () -> released.add("revokeChild"), () -> { })));

        verify(closer, never()).closeQuietly(any(), any(), eq(ExecutionLaunchRole.ROOT));
        assertEquals(List.of("revokeChild"), released,
                "子代理提交被拒时还没有执行对象，撤销的是子登记，绝不许去释放根资格");
    }

    @Test
    @DisplayName("准入被拒：撤销登记后不开跑")
    void admissionRejectedDoesNotRunBody() throws Exception {
        List<String> released = new ArrayList<>();
        List<String> bodies = new ArrayList<>();
        ExecutorService direct = Executors.newSingleThreadExecutor();
        try {
            gateway.submit(spec(ExecutionLaunchRole.SUB_AGENT, direct, null, () -> false,
                    () -> released.add("revokeChild"), () -> bodies.add("ran")));
            direct.shutdown();
            assertTrue(direct.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        } finally {
            direct.shutdownNow();
        }

        assertEquals(List.of("revokeChild"), released, "准入被拒必须撤销未开跑登记，不能留孤儿行");
        assertTrue(bodies.isEmpty(), "准入被拒时绝不能开跑");
    }

    @Test
    @DisplayName("准入通过：开跑一次，不做任何撤销")
    void admittedLaunchRunsBodyOnce() throws Exception {
        List<String> released = new ArrayList<>();
        List<String> bodies = new ArrayList<>();
        ExecutorService direct = Executors.newSingleThreadExecutor();
        try {
            gateway.submit(spec(ExecutionLaunchRole.ROOT, direct, execution("9302"), () -> true,
                    () -> released.add("finishRoot"), () -> bodies.add("ran")));
            direct.shutdown();
            assertTrue(direct.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS));
        } finally {
            direct.shutdownNow();
        }

        assertEquals(List.of("ran"), bodies);
        assertTrue(released.isEmpty(), "正常开跑时不得提前撤销登记");
    }

    @Test
    @DisplayName("入口校验：缺角色的请求直接拒绝，不做任何副作用")
    void invalidSpecIsRejectedWithoutSideEffects() {
        ExecutorService direct = Executors.newSingleThreadExecutor();
        try {
            assertThrows(IllegalArgumentException.class, () -> gateway.submit(
                    new ExecutionLaunchSpec(null, direct, null, () -> true, () -> { }, () -> { })));
            assertThrows(IllegalArgumentException.class, () -> gateway.submit(null));
        } finally {
            direct.shutdownNow();
        }
        verify(closer, never()).closeQuietly(any(), any(), any());
    }

    @Test
    @DisplayName("启动失败收口重复调用不产生第二次终态（幂等靠状态判据）")
    void repeatedReleaseDoesNotCloseTwice() {
        ExecutionControl control = mock(ExecutionControl.class);
        when(control.fail(any(), any())).thenAnswer(invocation -> {
            Execution target = invocation.getArgument(0);
            Exception cause = invocation.getArgument(1);
            target.failChecked(cause.getMessage());
            return (Runnable) () -> { };
        });
        ExecutionLaunchGateway realGateway = new ExecutionLaunchGateway(new StartupFailureCloser(control));
        Execution execution = execution("9303");
        ExecutorService noop = Executors.newSingleThreadExecutor();
        try {
            ExecutionLaunchSpec spec = spec(ExecutionLaunchRole.ROOT, noop, execution, () -> true, () -> { }, () -> { });
            RuntimeException cause = new IllegalStateException("线程池已满");

            assertTrue(realGateway.releaseUnstarted(spec, cause), "第一次必须真的写出终态");
            assertFalse(realGateway.releaseUnstarted(spec, cause),
                    "已终态的执行不得再收一次：重复收口会让收尸记录的时间随调用漂移");
            verify(control, org.mockito.Mockito.times(1)).fail(any(), any());
        } finally {
            noop.shutdownNow();
        }
    }

    private static ExecutionLaunchSpec spec(ExecutionLaunchRole role, ExecutorService executor,
                                            Execution execution, java.util.function.BooleanSupplier admission,
                                            Runnable onUnstarted, Runnable body) {
        return new ExecutionLaunchSpec(role, executor, execution, admission, onUnstarted, body);
    }

    /** 已关闭的线程池：提交必然被拒，用来稳定复现「线程池拒绝」。 */
    private static ExecutorService rejectingExecutor() {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.shutdown();
        return executor;
    }

    private static Execution execution(String id) {
        return Execution.builder().id(id).agentId("chatAgent")
                .executionState(ExecutionState.CREATED)
                .agentRequest(AgentRequest.builder().executionId(id).build())
                .build();
    }
}

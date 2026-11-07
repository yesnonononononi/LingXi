package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.workflow.application.chat.AgentWorkflowOrchestrator;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.harness.agent.SubAgent;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.AsyncDelegationSubmitter;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.AsyncDelegationTask;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.DelegationRecorder;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.session.SubSessionResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 两个真实启动入口必须真的经过统一启动入口。
 *
 * <p>这些用例打在 {@code PreparedChatExecutor#submitAsync} 与 {@code AsyncDelegationSubmitter#submit}
 * 上，而不是只测新类自己：只测新类的话，谁把入口改回直连都不会有任何用例变红，
 * 「统一」就退化成一句注释。</p>
 *
 * <p>观察手段是把真实网关包一层记录器（行为仍然是真实实现），因此断言的是「入口交出了什么样的
 * 启动请求」—— 角色、线程池、准入判据、撤销动作、启动体，全部可观察。</p>
 */
class ExecutionLaunchEntryTest {

    private final List<ExecutionLaunchSpec> launched = new ArrayList<>();
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();

    @Test
    @DisplayName("根会话入口：交出的启动请求是 ROOT 角色，撤销动作是释放根运行资格")
    void rootEntryLaunchesThroughGatewayWithRootRole() throws Exception {
        LaunchRecordingGateway gateway = new LaunchRecordingGateway();
        ExecutionContext executionContext = ExecutionContext.root(SESSION_ID, EXECUTION_ID_TEXT, null, null,
                null, null);
        PreparedChatExecutor executor = new PreparedChatExecutor(
                mock(AgentWorkflowOrchestrator.class), mock(RequestPreparer.class),
                mock(ModelContextService.class), registry, mock(ExecutionControl.class),
                new StartupFailureCloser(mock(ExecutionControl.class)), gateway);

        executor.submitAsync(new RuntimeContext(executionContext, null, null, null, null, null, null, null,
                null, false, null).withExecution(Execution.builder().id(EXECUTION_ID_TEXT).agentId("chatAgent")
                .executionState(ExecutionState.RUNNING)
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID_TEXT).build())
                .build()));

        assertTrue(gateway.launched.size() == 1,
                "根入口必须经过统一启动入口，改回各自直连时这里必须变红");
        ExecutionLaunchSpec spec = gateway.launched.get(0);
        assertEquals(ExecutionLaunchRole.ROOT, spec.role());
        assertNotNull(spec.executor(), "线程池由根入口自己提供，不能与子代理共用一个");
        assertEquals(EXECUTION_ID_TEXT, spec.execution().getId());
        assertTrue(spec.admission().getAsBoolean(), "根的准入在受理阶段已完成，提交时必须放行");
        spec.onUnstarted().run();
        assertTrue(spec.body() != null);
    }

    @Test
    @DisplayName("子代理入口：交出的启动请求是 SUB_AGENT 角色，准入是抢子登记")
    void childEntryLaunchesThroughGatewayWithSubAgentRole() {
        LaunchRecordingGateway gateway = new LaunchRecordingGateway();
        AsyncDelegationSubmitter submitter = new AsyncDelegationSubmitter(
                mock(SubAgent.class), registry, mock(SubSessionResolver.class),
                mock(DelegationRecorder.class), mock(ModelContextService.class),
                mock(ExecutionControl.class), new StartupFailureCloser(mock(ExecutionControl.class)),
                mock(SubExecutionLifecycle.class), gateway);

        submitter.submit(task());

        assertEquals(1, gateway.launched.size(),
                "子代理入口必须经过统一启动入口，改回各自直连时这里必须变红");
        ExecutionLaunchSpec spec = gateway.launched.get(0);
        assertEquals(ExecutionLaunchRole.SUB_AGENT, spec.role());
        assertNull(spec.execution(), "子代理提交时还没建执行：拒绝时只撤销登记，没有终态可收");
        assertNotNull(spec.executor(), "子代理有自己的线程池，不能借根的");
    }

    @Test
    @DisplayName("子代理没能起步时只撤销子登记，绝不释放根运行资格")
    void childUnstartedReleaseNeverTouchesRootQualification() {
        // 根先拿到运行资格：子代理若误用 finishRoot，这份资格就会被它偷偷释放。
        registry.beginRoot(ROOT_SESSION_ID, String.valueOf(ROOT_EXECUTION_ID));
        LaunchRecordingGateway gateway = new LaunchRecordingGateway();
        AsyncDelegationSubmitter submitter = new AsyncDelegationSubmitter(
                mock(SubAgent.class), registry, mock(SubSessionResolver.class),
                mock(DelegationRecorder.class), mock(ModelContextService.class),
                mock(ExecutionControl.class), new StartupFailureCloser(mock(ExecutionControl.class)),
                mock(SubExecutionLifecycle.class), gateway);

        submitter.submit(task());
        ExecutionLaunchSpec spec = gateway.launched.get(0);
        assertNotNull(spec.onUnstarted(), "子代理的启动请求必须自带子登记撤销动作");
        spec.onUnstarted().run();

        assertTrue(registry.isRootRunning(ROOT_SESSION_ID),
                "子代理撤回自己的登记时绝不能碰根运行资格 —— 根可能还在跑，或刚完工正要收尾");
    }

    /** 只有执行 ID 与两级会话 ID 参与启动请求，其余字段用不到。 */
    private static AsyncDelegationTask task() {
        return new AsyncDelegationTask(ROOT_SESSION_ID, SESSION_ID, null, ROOT_EXECUTION_ID, null, null,
                null, null, AgentRequest.builder().executionId(CHILD_EXECUTION_ID).build());
    }

    private static final String EXECUTION_ID_TEXT = "9401";
    private static final String CHILD_EXECUTION_ID = "9403";
    private static final Long ROOT_SESSION_ID = 9402L;
    private static final Long SESSION_ID = 9404L;
    private static final Long ROOT_EXECUTION_ID = 9405L;

    /** 记录型网关：行为仍然是真实实现，只多记一份「入口交了什么」。 */
    private static final class LaunchRecordingGateway extends ExecutionLaunchGateway {

        private final List<ExecutionLaunchSpec> launched = new ArrayList<>();

        private LaunchRecordingGateway() {
            super(new StartupFailureCloser(mock(ExecutionControl.class)));
        }

        @Override
        public void submit(ExecutionLaunchSpec spec) {
            launched.add(spec);
        }
    }

}

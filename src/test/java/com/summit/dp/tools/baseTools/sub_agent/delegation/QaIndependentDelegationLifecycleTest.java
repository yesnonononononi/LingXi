package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.CallSubAgentTool;
import com.summit.dp.tools.baseTools.sub_agent.result.AsyncDelegationResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionTarget;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.lang.reflect.Field;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 独立验证（QA）：委派生命周期的六类交错场景 + 泄漏/残留检查。
 *
 * <p>与 {@code QaDelegationLifecycleInterleavingTest} 的关系：那条用「每轮结束事故事件 + 顺序调用」
 * 覆盖正向路径；本类刻意换一组观察点 —— 待启动/挂起态的门控、两种相对顺序、<b>worker 运行期间
 * 第二次唤醒不得丢失</b>（用 latch 卡住首轮 resume 而非事后轮询）、失败/取消的结束事实，
 * 以及注册表条目与保留唤醒的真实回收。所有时序观察一律用 latch / 计数自旋，<b>不用 sleep</b>。</p>
 */
class QaIndependentDelegationLifecycleTest {

    private static final long ROOT_SESSION_ID = 8000L;
    private static final long ROOT_EXECUTION_ID = 9900L;
    private static final long ROOT_AGENT_ID = 7L;
    private static final long CHILD_SESSION_ID = 660L;
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

    private final AtomicBoolean rootActive = new AtomicBoolean(false);
    private final AtomicInteger resumeCount = new AtomicInteger();
    private final AtomicReference<List<ExecutionResumeTask>> liveTasks = new AtomicReference<>(List.of());

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
        when(frameworkExecutions.findById(String.valueOf(ROOT_EXECUTION_ID)))
                .thenReturn(Optional.of(rootExecution()));
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(frameworkExecutions).afterCommit(any());
        when(tasks.enqueue(anyLong(), anyLong(), any())).thenAnswer(invocation -> newTask());
        when(tasks.findByExecutionId(ROOT_EXECUTION_ID)).thenAnswer(invocation -> List.of(newTask()));
        when(tasks.claim(any())).thenAnswer(invocation -> {
            ((ExecutionResumeTask) invocation.getArgument(0)).claim();
            return true;
        });
        when(tasks.listLiveByExecution(ROOT_EXECUTION_ID)).thenAnswer(invocation -> liveTasks.get());
        when(tasks.updateState(any())).thenReturn(true);
        when(toolCallRepository.listUnresolvedByExecutionId(ROOT_EXECUTION_ID)).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        coordinator.close();
    }

    // ------------------------------------------------------------------
    // 场景 1：子任务未启动就收尾
    // ------------------------------------------------------------------

    @Test
    @DisplayName("① 待启动子执行（已受理未开跑）→ 根驻留不收尾；revokeChild 撤销后恢复「无未结束子」")
    void pendingStartKeepsRootResidentUntilRevoked() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        assertTrue(registry.registerPendingChild(ROOT_SESSION_ID, CHILD_SESSION_ID));

        InterceptorResult resident = waitInterceptor.onBeforeComplete(rootLoopContext());
        assertFalse(resident.shouldContinue(), "已受理但尚未开跑的子执行也算未结束，根不得提前完成");
        assertEquals(LoopResult.Status.SUSPENDED, resident.loopResult().status());

        registry.revokeChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID), "撤销后应恢复为无未结束子");
        assertEquals(0, resumeCount.get());
    }

    @Test
    @DisplayName("①' CallSubAgentTool：提交失败必须撤销待启动登记，不留幽灵子执行")
    void submitFailureRevokesPendingRegistration() {
        ObjectMapper objectMapper = new ObjectMapper();
        AgentService agentService = mock(AgentService.class);
        TeamService teamService = mock(TeamService.class);
        SubAgentRequestFactory requestFactory = mock(SubAgentRequestFactory.class);
        SubSessionResolver subSessionResolver = mock(SubSessionResolver.class);
        SessionRepository sessionRepository = mock(SessionRepository.class);
        AsyncDelegationSubmitter submitter = mock(AsyncDelegationSubmitter.class);
        AsyncDelegationResultRenderer renderer = mock(AsyncDelegationResultRenderer.class);

        AgentVO childAgent = new AgentVO();
        childAgent.setId(5L);
        childAgent.setName("干活的人");
        childAgent.setModelId(1L);
        AgentVO commander = new AgentVO();
        commander.setId(ROOT_AGENT_ID);
        commander.setName("指挥");
        when(agentService.findById(5L)).thenReturn(Result.success(childAgent));
        when(teamService.findById(42L)).thenReturn(Result.success(
                TeamVO.builder().id(42L).commanderAgentId(ROOT_AGENT_ID)
                        .agents(List.of(childAgent, commander)).build()));
        when(sessionRepository.findById(ROOT_SESSION_ID)).thenReturn(Optional.empty());
        when(subSessionResolver.resolve(ROOT_SESSION_ID, childAgent)).thenReturn(SubSessionTarget.fresh("660"));
        when(requestFactory.build(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(mock(AgentRequest.class));

        // 提交失败：线程池拒绝之类。
        doThrow(new RuntimeException("pool rejected")).when(submitter).submit(any());
        SessionExecutionRegistry failingRegistry = new SessionExecutionRegistry();
        CallSubAgentTool failingTool = new CallSubAgentTool(objectMapper, agentService, teamService, requestFactory,
                subSessionResolver, failingRegistry, sessionRepository, submitter, renderer);

        ToolExecuteResult failed = failingTool.execute(delegationExecution());
        assertFalse(failed.isSuccess(), "提交失败必须报错，不能谎报已委派");
        assertFalse(failingRegistry.hasUnfinishedChildren(ROOT_SESSION_ID),
                "提交失败必须撤销待启动登记，否则根会以为有子执行而永久驻留");

        // 提交成功：登记保留（登记早于提交），供根驻留判定使用。
        doNothing().when(submitter).submit(any());
        when(renderer.render(any(), any(), any())).thenReturn(ToolExecuteResult.success("accepted"));
        SessionExecutionRegistry okRegistry = new SessionExecutionRegistry();
        CallSubAgentTool okTool = new CallSubAgentTool(objectMapper, agentService, teamService, requestFactory,
                subSessionResolver, okRegistry, sessionRepository, submitter, renderer);

        assertTrue(okTool.execute(delegationExecution()).isSuccess());
        assertTrue(okRegistry.hasUnfinishedChildren(ROOT_SESSION_ID), "提交成功后待启动登记必须保留");
    }

    // ------------------------------------------------------------------
    // 场景 2：结束恰好撞上挂起（两种相对顺序）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("②A 子先终结（根活跃）→ 保留唤醒；根随后挂起 → 重放恰好一次恢复")
    void finishWhileRootActiveRetainsWakeThenSuspendReplays() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID);

        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        assertEquals(0, resumeCount.get(), "根仍活跃时不得派发，只保留唤醒");
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID));

        suspendRoot();
        awaitResumeCount(1);
    }

    @Test
    @DisplayName("②B 根先挂起 → 子随后终结 → 结束事实直接唤醒，恰好一次恢复")
    void suspendBeforeFinishWakesRootDirectly() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID);

        suspendRoot();
        assertEquals(0, resumeCount.get(), "无保留唤醒时挂起不触发恢复");

        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumeCount(1);
    }

    // ------------------------------------------------------------------
    // 场景 3：连续两次恢复 —— worker 运行期第二次唤醒不得丢失
    // ------------------------------------------------------------------

    @Test
    @DisplayName("③ worker 运行期间第二次唤醒入队 → 门闩 CAS 失败被挡 → 退出前复查再派发，最终两次恢复")
    void secondWakeDuringWorkerRunIsNotLost() throws Exception {
        CountDownLatch firstResumeEntered = new CountDownLatch(1);
        CountDownLatch releaseFirstResume = new CountDownLatch(1);
        // 用 doAnswer 覆盖既有桩：when(...) 形式会「求值」一次既有桩，把计数打乱。
        doAnswer(invocation -> {
            int sequence = resumeCount.incrementAndGet();
            if (sequence == 1) {
                firstResumeEntered.countDown();
                await(releaseFirstResume);
            }
            return invocation.getArgument(0);
        }).when(executionControl).resume(any());

        // 第一轮：根未活跃，结束事实直接派发恢复（worker 卡在 resume）。
        ExecutionResumeTask first = newTask();
        ExecutionResumeTask second = newTask();
        AtomicReference<List<ExecutionResumeTask>> snapshot = new AtomicReference<>(List.of(first));
        when(tasks.findByExecutionId(ROOT_EXECUTION_ID)).thenAnswer(invocation -> snapshot.get());
        when(tasks.enqueue(anyLong(), anyLong(), any())).thenReturn(first, second);
        liveTasks.set(List.of(first));

        registry.beginRoot(ROOT_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID);
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        await(firstResumeEntered);

        // 第二轮唤醒：worker 仍持门闩，dispatch 被 CAS 挡下 —— 请求必须留在队列里。
        snapshot.set(List.of(first, second));
        liveTasks.set(List.of(second));
        delegateRunningChild(CHILD_SESSION_ID + 1);
        lifecycle.onFinished(childExecution(CHILD_SESSION_ID + 1));

        // 放行首轮 resume：worker 退出前复查发现仍 READY 的第二条请求 → 再派发 → 第二次恢复。
        releaseFirstResume.countDown();
        awaitResumeCount(2);
    }

    // ------------------------------------------------------------------
    // 场景 4：子执行等待审批
    // ------------------------------------------------------------------

    @Test
    @DisplayName("④ 子执行挂起等审批 → 仍算未结束、根驻留；审批后终结 → 唤醒根")
    void childWaitingApprovalKeepsRootThenWakesOnFinish() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID);

        lifecycle.onSuspended(childExecution(CHILD_SESSION_ID));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID), "等审批的子执行仍算未结束");

        assertFalse(waitInterceptor.onBeforeComplete(rootLoopContext()).shouldContinue(),
                "有等审批子执行时根不得收尾");
        assertEquals(0, resumeCount.get());

        suspendRoot();
        assertEquals(0, resumeCount.get(), "子执行尚未终结，不得唤醒");

        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        awaitResumeCount(1);
    }

    // ------------------------------------------------------------------
    // 场景 6：子执行失败 / 取消
    // ------------------------------------------------------------------

    @Test
    @DisplayName("⑥ 多子执行逐个失败/取消：非最后一个不唤醒，最后一个终结才生成结束事实并唤醒根")
    void failureAndCancellationWakeOnLastTerminalOnly() {
        // 根持有控制槽位：非最后一个终结即便误走唤醒路径，也只会被「保留」，必须等到根挂起才可能重放；
        // 因此这里用「根挂起后仍无恢复」来确定性证伪「过度唤醒」，而不是与异步派发赌时序。
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID);
        delegateRunningChild(CHILD_SESSION_ID + 1);

        lifecycle.onFinished(childExecution(CHILD_SESSION_ID));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        assertNoResumeWithin();

        suspendRoot();
        assertNoResumeWithin();

        lifecycle.onFinished(childExecution(CHILD_SESSION_ID + 1));
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID));
        awaitResumeCount(1);
    }

    // ------------------------------------------------------------------
    // 泄漏 / 残留
    // ------------------------------------------------------------------

    @Test
    @DisplayName("泄漏：根终态必须清掉保留唤醒（否则会唤醒一个再也不会挂起的执行）")
    void rootTerminalClearsRetainedWake() {
        rootActive.set(true);
        registry.beginRoot(ROOT_SESSION_ID);
        coordinator.accept(ROOT_EXECUTION_ID);
        assertEquals(0, resumeCount.get(), "根活跃时唤醒被保留");

        lifecycle.onFinished(rootExecution());
        rootActive.set(false);
        coordinator.flushPendingWake(ROOT_EXECUTION_ID);

        assertEquals(0, resumeCount.get(), "保留唤醒已被清理，flush 必须是 no-op");
    }

    @Test
    @DisplayName("回收：注册表条目仅当「根已收尾且子已清空」时才从 roots 移除，早一格都不能删")
    void registryEntryReclaimedOnlyWhenRootAndChildrenGone() throws Exception {
        registry.beginRoot(ROOT_SESSION_ID);
        registry.bindRunningChild(ROOT_SESSION_ID, CHILD_SESSION_ID, Thread.currentThread());

        registry.finishRoot(ROOT_SESSION_ID);
        assertTrue(rootsOf(registry).containsKey(ROOT_SESSION_ID),
                "根收尾但子仍在跑时，条目不得被 removeIfFinished 误删");

        registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        assertFalse(rootsOf(registry).containsKey(ROOT_SESSION_ID),
                "根已收尾且子已清空后，条目必须被回收");
    }

    // ------------------------------------------------------------------
    // 编排辅助
    // ------------------------------------------------------------------

    private void suspendRoot() {
        rootActive.set(false);
        lifecycle.onSuspended(rootExecution());
    }

    private void delegateRunningChild(long childSessionId) {
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
        return Execution.builder().id(String.valueOf(ROOT_EXECUTION_ID))
                .executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                                .build())
                        .build())
                .build();
    }

    private static ToolExecution delegationExecution() {
        return ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(
                        ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                        ExecutionAttributes.TEAM_ID, "42"))
                .args("{\"agentId\":5,\"task\":\"干活\",\"workDir\":\"D:/tmp\"}")
                .build();
    }

    private ExecutionResumeTask newTask() {
        return ExecutionResumeTask.builder().id(1L).executionId(ROOT_EXECUTION_ID)
                .generation(GENERATION).state(ResumeTaskState.READY).version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    @SuppressWarnings("unchecked")
    private static Map<Object, Object> rootsOf(SessionExecutionRegistry registry) throws Exception {
        Field field = SessionExecutionRegistry.class.getDeclaredField("roots");
        field.setAccessible(true);
        return (Map<Object, Object>) field.get(registry);
    }

    private void awaitResumeCount(int expected) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(AWAIT_TIMEOUT_SECONDS);
        while (resumeCount.get() < expected && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertEquals(expected, resumeCount.get(),
                "应在超时前观察到 " + expected + " 次恢复，实际=" + resumeCount.get());
    }

    /** 有界自旋确认「此路径不得产生恢复」：给异步 worker 一个确定性的观察窗口，命中即立刻判红。 */
    private void assertNoResumeWithin() {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(500);
        while (resumeCount.get() == 0 && System.nanoTime() < deadline) {
            Thread.onSpinWait();
        }
        assertEquals(0, resumeCount.get(), "此路径不得产生任何恢复，实际=" + resumeCount.get());
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

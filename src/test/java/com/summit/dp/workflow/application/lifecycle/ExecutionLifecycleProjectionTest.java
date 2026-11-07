package com.summit.dp.workflow.application.lifecycle;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * 生命周期投影的步骤顺序、失败分级与补偿。
 *
 * <p>这里守的是「为什么这样排序、为什么这一步必须成功」这份唯一知识：顺序被调换、或者必须成功的
 * 步骤失败后被当成没事，不会让任何编译出错，只会让线上出现「轮次已完成但卡片还亮着」
 * 「子代理交付了但根永远不继续」这类同步问题。</p>
 *
 * <p>用记录型假实现（{@link #steps}）而不是 {@code InOrder}：断言的是一个可读的调用序列，
 * 变异时能直接看出「哪一步跑到了前面」或「哪一步被跳过了」。</p>
 */
class ExecutionLifecycleProjectionTest {

    private static final long EXECUTION_ID = 700L;
    private static final String EXECUTION_ID_TEXT = "700";

    private final List<String> steps = new ArrayList<>();
    private final ToolCallReadinessService readiness = mock(ToolCallReadinessService.class);
    private final ToolCallService toolCalls = mock(ToolCallService.class);
    private final SubExecutionLifecycle subExecution = mock(SubExecutionLifecycle.class);
    private final SessionContextUsageProjector usage = mock(SessionContextUsageProjector.class);
    private final ChatTurnLifecycleProjector turns = mock(ChatTurnLifecycleProjector.class);
    private final RuntimeEventPublisher events = mock(RuntimeEventPublisher.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);

    private Logger logger;
    private ListAppender<ILoggingEvent> logs;

    @BeforeEach
    void recordEveryStep() {
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_RELEASE_CARDS))
                .when(readiness).markReady(anyString());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_WAITING_TURN))
                .when(turns).markExecutionWaiting(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_CLOSE_CARDS))
                .when(toolCalls).cancelPendingToolCalls(anyString());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED))
                .when(subExecution).onFinished(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_SAVE_USAGE))
                .when(usage).saveExecutionContextUsage(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_FINISH_TURN))
                .when(turns).finishExecution(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED))
                .when(events).onExecutionCancelled(any(ExecutionCancelledEvent.class));
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT))
                .when(wakeups).resumeIfInputPending(anyLong());

        logger = (Logger) LoggerFactory.getLogger(ExecutionLifecycleProjection.class);
        logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
    }

    @AfterEach
    void detachLogger() {
        logger.detachAppender(logs);
    }

    @Test
    @DisplayName("终结投影：卡片 → 子执行结束事实 → 会话用量 → 业务轮次 → 自动唤醒，顺序不可交换")
    void finishedStepsRunInCausalOrder() {
        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().onFinished(execution(ExecutionState.COMPLETED));

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED,
                ExecutionLifecycleProjection.STEP_SAVE_USAGE,
                ExecutionLifecycleProjection.STEP_FINISH_TURN,
                ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT), steps,
                "业务轮次必须最后收口（前面几步还会往轮次上追加卡片结果与用量），自动唤醒必须在全部落库之后");
        assertTrue(outcome.complete(), "全部步骤成功时收口必须报告完整");
        assertTrue(outcome.failedRequired().isEmpty());
    }

    @Test
    @DisplayName("取消投影：终态事件排在业务轮次收口之后")
    void cancelledBroadcastFollowsTurnClosing() {
        projection().onCancelled(execution(ExecutionState.CANCELLED));

        assertTrue(steps.indexOf(ExecutionLifecycleProjection.STEP_FINISH_TURN)
                        < steps.indexOf(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED),
                "订阅方拿到「已取消」时必须能读到已收口的轮次");
        assertEquals(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED, steps.get(steps.size() - 1),
                "取消终态是最后一个动作：先让轮次收口、再让界面知道执行没了");
    }

    @Test
    @DisplayName("挂起投影：先开放卡片再标等待轮次")
    void suspendedStepsOpenCardsBeforeWaitingTurn() {
        projection().onSuspended(execution(ExecutionState.SUSPENDED));

        assertEquals(List.of(ExecutionLifecycleProjection.STEP_RELEASE_CARDS,
                ExecutionLifecycleProjection.STEP_WAITING_TURN), steps);
    }

    @Test
    @DisplayName("必须步骤失败：中断后续步骤，不把轮次标成正常结束，并留下不完整标记")
    void requiredStepFailureAbortsWithoutPublishingSuccess() {
        // 子执行结束事实是必须步骤：它失败说明根仍被判为「还在等子代理」。
        doAnswer(invocation -> {
            steps.add(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED);
            throw new IllegalStateException("终止子执行失败");
        }).when(subExecution).onFinished(any());
        Execution finished = execution(ExecutionState.COMPLETED);

        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().onFinished(finished);

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED), steps,
                "必须步骤失败后不得继续：继续就会把轮次标成正常结束，产出带着缺失事实的成功结果");
        assertFalse(outcome.complete(), "必须步骤没做成时收口必须报告不完整");
        assertEquals(List.of(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED), outcome.failedRequired(),
                "失败步骤必须按名字进结果，调用方才能判断是哪一环没做成");
        assertEquals(Boolean.TRUE,
                InputAutomationPolicy.attributes(finished).get(ExecutionLifecycleProjection.CLOSURE_INCOMPLETE),
                "不完整收口必须留下标记，供下一次落库与启动巡检补做");
        String logged = firstLifecycleError();
        assertTrue(logged.contains("executionId=" + EXECUTION_ID), "日志必须能定位到具体执行: " + logged);
        assertTrue(logged.contains("step=" + ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED),
                "日志必须写明是哪一步失败: " + logged);
        assertTrue(logged.contains("level=REQUIRED"), "日志必须写明这一步的级别: " + logged);
    }

    @Test
    @DisplayName("必须步骤（收口工具卡片）失败同样中断：不许轮次先收口而卡片还亮着")
    void closeCardsFailureAlsoAborts() {
        doAnswer(invocation -> {
            throw new IllegalStateException("工具卡片收口失败");
        }).when(toolCalls).cancelPendingToolCalls(anyString());

        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().onFinished(execution(ExecutionState.CANCELLED));

        assertTrue(steps.isEmpty(), "第一步就失败时不得继续执行任何后续步骤");
        assertEquals(List.of(ExecutionLifecycleProjection.STEP_CLOSE_CARDS), outcome.failedRequired());
        assertFalse(outcome.complete());
    }

    @Test
    @DisplayName("尽力步骤失败：只记录，不中断，不影响收口完整性")
    void bestEffortStepFailureDoesNotAbort() {
        doAnswer(invocation -> {
            steps.add(ExecutionLifecycleProjection.STEP_SAVE_USAGE);
            throw new IllegalStateException("会话用量保存失败");
        }).when(usage).saveExecutionContextUsage(any());
        Execution finished = execution(ExecutionState.COMPLETED);

        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().onFinished(finished);

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED,
                ExecutionLifecycleProjection.STEP_SAVE_USAGE,
                ExecutionLifecycleProjection.STEP_FINISH_TURN,
                ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT), steps,
                "用量只是统计信息，失败不得阻止轮次收口");
        assertTrue(outcome.complete(), "只有尽力步骤失败时收口仍然完整");
        assertEquals(List.of(ExecutionLifecycleProjection.STEP_SAVE_USAGE), outcome.failedBestEffort());
        assertNull(InputAutomationPolicy.attributes(finished).get(ExecutionLifecycleProjection.CLOSURE_INCOMPLETE),
                "收口完整时必须清掉不完整标记，否则补偿会无谓地反复重做");
    }

    @Test
    @DisplayName("取消投影：终结不完整时不广播取消")
    void cancelledBroadcastSuppressedWhenClosureIncomplete() {
        doAnswer(invocation -> {
            throw new IllegalStateException("工具卡片收口失败");
        }).when(toolCalls).cancelPendingToolCalls(anyString());

        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().onCancelled(execution(ExecutionState.CANCELLED));

        assertFalse(steps.contains(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED),
                "轮次都没收口就广播「已取消」，订阅方会读到互相矛盾的两个事实");
        assertFalse(outcome.complete());
    }

    @Test
    @DisplayName("补偿入口：补做后收口真正完成，再调一次副作用只发生一次")
    void completeClosureRepairsOnceAndIsIdempotent() {
        // 轮次终态按状态判据幂等：同一执行第二次 markTerminal 不再产生新的可见变化。
        Set<String> alreadyTerminal = new HashSet<>();
        List<String> effectiveTurnClosures = new ArrayList<>();
        ChatTurnService turnService = mock(ChatTurnService.class);
        doAnswer(invocation -> {
            String executionId = invocation.getArgument(0);
            if (alreadyTerminal.add(executionId)) {
                effectiveTurnClosures.add(executionId);
                steps.add(ExecutionLifecycleProjection.STEP_FINISH_TURN);
            }
            return null;
        }).when(turnService).markTerminal(anyString(), any(ChatTurnStatus.class), any(), any(), any(),
                any(), any());
        ExecutionLifecycleProjection realTurns = projectionWithRealTurnProjector(turnService);

        // 第一次收口：子执行结束事实失败 → 中断 → 轮次没被标终态。
        RuntimeException deliveryFailure = new IllegalStateException("子执行交付失败");
        doAnswer(invocation -> {
            throw deliveryFailure;
        }).when(subExecution).onFinished(any());
        Execution cancelled = execution(ExecutionState.CANCELLED);
        ExecutionLifecycleProjection.ClosureOutcome first = realTurns.onFinished(cancelled);

        assertFalse(first.complete());
        assertTrue(effectiveTurnClosures.isEmpty(), "必须步骤失败时轮次不得被标成终态");
        assertEquals(Boolean.TRUE,
                InputAutomationPolicy.attributes(cancelled).get(ExecutionLifecycleProjection.CLOSURE_INCOMPLETE));

        // 故障消除后补偿：收口真正完成，轮次拿到终态。
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED))
                .when(subExecution).onFinished(any());
        ExecutionLifecycleProjection.ClosureOutcome repaired = realTurns.completeClosure(cancelled);

        assertTrue(repaired.complete(), "补偿后必须报告收口完整");
        assertEquals(List.of(EXECUTION_ID_TEXT), effectiveTurnClosures, "补偿必须把轮次真正收到终态");
        assertNull(InputAutomationPolicy.attributes(cancelled).get(ExecutionLifecycleProjection.CLOSURE_INCOMPLETE),
                "补偿成功后必须清掉标记，否则每次落库都会重复补做");

        // 再调一次：副作用不得重复发生（靠状态判据，不靠内存「跑过一次」）。
        ExecutionLifecycleProjection.ClosureOutcome again = realTurns.completeClosure(cancelled);

        assertTrue(again.complete());
        assertEquals(List.of(EXECUTION_ID_TEXT), effectiveTurnClosures,
                "重复补偿不得再产生一次轮次收口副作用");
    }

    @Test
    @DisplayName("补偿入口：未到终态的执行不补收口")
    void completeClosureRejectsNonTerminalExecution() {
        Execution running = execution(ExecutionState.RUNNING);

        ExecutionLifecycleProjection.ClosureOutcome outcome = projection().completeClosure(running);

        assertFalse(outcome.complete());
        assertTrue(steps.isEmpty(), "未到终态就补收口等于替用户做结束决定");
    }

    @Test
    @DisplayName("暂停意图补写：只有「停在挂起点 + 控制槽位要求暂停」才落 USER_PAUSED")
    void pauseIntentOnlyAppliedWhenSuspensionIsRequired() {
        Execution suspended = execution(ExecutionState.SUSPENDED);
        projection().applyPauseIntent(suspended, true);
        assertTrue(InputAutomationPolicy.attributes(suspended).containsKey(InputAutomationPolicy.USER_PAUSED));

        Execution notRequired = execution(ExecutionState.SUSPENDED);
        projection().applyPauseIntent(notRequired, false);
        assertFalse(InputAutomationPolicy.attributes(notRequired).containsKey(InputAutomationPolicy.USER_PAUSED),
                "控制槽位没要求暂停时补写意图，会让恢复后的执行被 register 拒绝");

        Execution running = execution(ExecutionState.RUNNING);
        projection().applyPauseIntent(running, true);
        assertFalse(InputAutomationPolicy.attributes(running).containsKey(InputAutomationPolicy.USER_PAUSED),
                "只有真正停在挂起点的执行才有暂停意图");
    }

    /** 第一条生命周期错误日志：断言用，取不到就失败（静默丢失本身就是缺陷）。 */
    private String firstLifecycleError() {
        return logs.list.stream().map(ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("执行生命周期处理失败"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("失败步骤必须留下日志，实际无任何相关日志"));
    }

    private Object record(String step) {
        steps.add(step);
        return null;
    }

    private ExecutionLifecycleProjection projection() {
        return new ExecutionLifecycleProjection(
                provider(ToolCallReadinessService.class, readiness),
                provider(ToolCallService.class, toolCalls),
                provider(SubExecutionLifecycle.class, subExecution),
                provider(SessionContextUsageProjector.class, usage),
                provider(ChatTurnLifecycleProjector.class, turns),
                provider(RuntimeEventPublisher.class, events),
                provider(InputWakeupService.class, wakeups));
    }

    /** 幂等用例要真的走轮次投影：状态判据在它下游的服务里，mock 掉就测不到了。 */
    private ExecutionLifecycleProjection projectionWithRealTurnProjector(ChatTurnService turnService) {
        return new ExecutionLifecycleProjection(
                provider(ToolCallReadinessService.class, readiness),
                provider(ToolCallService.class, toolCalls),
                provider(SubExecutionLifecycle.class, subExecution),
                provider(SessionContextUsageProjector.class, usage),
                provider(ChatTurnLifecycleProjector.class, new ChatTurnLifecycleProjector(turnService)),
                provider(RuntimeEventPublisher.class, events),
                provider(InputWakeupService.class, wakeups));
    }

    private static Execution execution(ExecutionState state) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(com.summit.dp.execution.ExecutionAttributes.SESSION_ID, "820");
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .executionState(state)
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T service) {
        return new StaticListableBeanFactory(Map.of("value", service)).getBeanProvider(type);
    }
}

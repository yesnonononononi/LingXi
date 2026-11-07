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
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 收口脚本的顺序、失败中断与补偿语义。
 *
 * <p>这里守的是「为什么这样排序、失败了会怎样」这份唯一知识：顺序被调换、或者必须成功的一步
 * 失败后被当成没事，都不会让任何编译出错，只会让线上出现「轮次已完成但卡片还亮着」
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
    private final ExecutionRepository executions = mock(ExecutionRepository.class);

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
        when(executions.clearClosurePending(anyLong())).thenAnswer(invocation -> {
            steps.add(ExecutionLifecycleProjection.STEP_CLEAR_PENDING);
            return true;
        });

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
    @DisplayName("终结收口：卡片 → 子执行结束事实 → 会话用量 → 业务轮次 → 清待收口位 → 自动唤醒")
    void closedTerminalStepsRunInCausalOrder() {
        projection().completeClosure(execution(ExecutionState.COMPLETED), false);

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED,
                ExecutionLifecycleProjection.STEP_SAVE_USAGE,
                ExecutionLifecycleProjection.STEP_FINISH_TURN,
                ExecutionLifecycleProjection.STEP_CLEAR_PENDING,
                ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT), steps,
                "业务轮次必须收在清位之前、清位必须排在唤醒之前：先让事实落库，再对外喊话");
        verify(events, never()).onExecutionCancelled(any(ExecutionCancelledEvent.class));
    }

    @Test
    @DisplayName("取消收口：轮次收口 → 清待收口位 → 广播「已取消」")
    void cancelledBroadcastHappensOnlyAfterTurnClosedAndFlagCleared() {
        projection().completeClosure(execution(ExecutionState.CANCELLED), true);

        assertTrue(steps.indexOf(ExecutionLifecycleProjection.STEP_FINISH_TURN)
                        < steps.indexOf(ExecutionLifecycleProjection.STEP_CLEAR_PENDING),
                "订阅方拿到「已取消」时必须能读到已收口的轮次");
        assertTrue(steps.indexOf(ExecutionLifecycleProjection.STEP_CLEAR_PENDING)
                        < steps.indexOf(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED),
                "广播必须排在清待收口位之后：先把「收口做完了」写进库，再对外发通知");
        assertEquals(ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT, steps.get(steps.size() - 1),
                "唤醒是最后一个动作");
    }

    @Test
    @DisplayName("挂起投影：先开放卡片再标等待轮次")
    void suspendedStepsOpenCardsBeforeWaitingTurn() {
        projection().onSuspended(execution(ExecutionState.SUSPENDED));

        assertEquals(List.of(ExecutionLifecycleProjection.STEP_RELEASE_CARDS,
                ExecutionLifecycleProjection.STEP_WAITING_TURN), steps);
    }

    @Test
    @DisplayName("必须步骤失败：中断后续、不清待收口位、不广播，日志带执行与步骤名")
    void requiredStepFailureAbortsWithoutPublishingSuccess() {
        // 子执行结束事实是必须步骤：它失败说明根仍被判为「还在等子代理」。
        doAnswer(invocation -> {
            steps.add(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED);
            throw new IllegalStateException("终止子执行失败");
        }).when(subExecution).onFinished(any());

        projection().completeClosure(execution(ExecutionState.CANCELLED), true);

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED), steps,
                "必须步骤失败后不得继续：继续就会把轮次标成正常结束，产出带着缺失事实的成功结果");
        verify(events, never()).onExecutionCancelled(any(ExecutionCancelledEvent.class));
        verify(executions, never()).clearClosurePending(anyLong());
        String logged = firstLifecycleError();
        assertTrue(logged.contains("executionId=" + EXECUTION_ID), "日志必须能定位到具体执行: " + logged);
        assertTrue(logged.contains("step=" + ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED),
                "日志必须写明是哪一步失败: " + logged);
        assertTrue(logged.contains("终止子执行失败"), "日志必须带上原始异常: " + logged);
    }

    @Test
    @DisplayName("必须步骤（收口工具卡片）失败同样中断：不许轮次先收口而卡片还亮着")
    void closeCardsFailureAlsoAborts() {
        doAnswer(invocation -> {
            throw new IllegalStateException("工具卡片收口失败");
        }).when(toolCalls).cancelPendingToolCalls(anyString());

        projection().completeClosure(execution(ExecutionState.CANCELLED), true);

        assertTrue(steps.isEmpty(), "第一步就失败时不得继续执行任何后续步骤");
        verify(executions, never()).clearClosurePending(anyLong());
    }

    @Test
    @DisplayName("用量是业务状态：写失败必须中断、不清位、不广播，等补偿重做")
    void usageStepFailureAbortsClosure() {
        doAnswer(invocation -> {
            steps.add(ExecutionLifecycleProjection.STEP_SAVE_USAGE);
            throw new IllegalStateException("会话用量保存失败");
        }).when(usage).saveExecutionContextUsage(any());

        projection().completeClosure(execution(ExecutionState.COMPLETED), false);

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED,
                ExecutionLifecycleProjection.STEP_SAVE_USAGE), steps,
                "用量缺失会让计费与用量视图永久少一段，必须中断而不是记日志继续");
        verify(turns, never()).finishExecution(any());
        verify(executions, never()).clearClosurePending(anyLong());
        verify(events, never()).onExecutionCancelled(any());
    }

    @Test
    @DisplayName("收口脚本单步失败即抛，带步骤名（调用方据此记日志，不吞异常）")
    void closeTerminalThrowsWithStepName() {
        doAnswer(invocation -> {
            throw new IllegalStateException("轮次收口失败");
        }).when(turns).finishExecution(any());

        ExecutionLifecycleProjection.ExecutionClosureFailure failure = assertThrows(
                ExecutionLifecycleProjection.ExecutionClosureFailure.class,
                () -> projection().closeTerminal(execution(ExecutionState.COMPLETED)));

        assertEquals(ExecutionLifecycleProjection.STEP_FINISH_TURN, failure.step());
    }

    @Test
    @DisplayName("补偿入口：未到终态的执行不收口")
    void completeClosureRejectsNonTerminalExecution() {
        projection().completeClosure(execution(ExecutionState.RUNNING), false);

        assertTrue(steps.isEmpty(), "未到终态就收口等于替用户做结束决定");
        verify(executions, never()).clearClosurePending(anyLong());
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

    /** 第一条收口错误日志：断言用，取不到就失败（静默丢失本身就是缺陷）。 */
    private String firstLifecycleError() {
        return logs.list.stream().map(ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("执行收口失败"))
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
                provider(InputWakeupService.class, wakeups),
                provider(ExecutionRepository.class, executions));
    }

    private static Execution execution(ExecutionState state) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, "820");
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

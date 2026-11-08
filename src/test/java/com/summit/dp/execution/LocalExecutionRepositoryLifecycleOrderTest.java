package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 仓储与投影的分工守卫：终结投影必须早于框架发布终态事件，且仓储不再持有业务协作方。
 *
 * <p>框架的顺序是「save(FAILED) → 返回发布任务 → 调用方 run 它」。业务侧没有排序权，
 * 只能在保存提交后、框架发布之前把轮次收口补上；顺序一旦反了，界面会先收到终态、
 * 后收到轮次更新，出现「执行结束了但轮次还转着」的瞬间。</p>
 */
class LocalExecutionRepositoryLifecycleOrderTest {

    private static final long EXECUTION_ID = 880L;
    private static final long SESSION_ID = 920L;
    private static final String FRAMEWORK_TERMINAL_EVENT = "框架终态事件";

    private final List<String> steps = new ArrayList<>();
    private final ToolCallService toolCalls = mock(ToolCallService.class);
    private final SubExecutionLifecycle subExecution = mock(SubExecutionLifecycle.class);
    private final SessionContextUsageProjector usage = mock(SessionContextUsageProjector.class);
    private final ChatTurnLifecycleProjector turns = mock(ChatTurnLifecycleProjector.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);

    @Test
    @DisplayName("终结投影落在框架发布终态事件之前")
    void finishingProjectionRunsBeforeFrameworkTerminalEvent() {
        recordSteps();
        LocalExecutionRepository repository = repository();
        Execution failed = execution(ExecutionState.FAILED);

        TransactionSynchronizationManager.initSynchronization();
        try {
            // 框架 fail()：先 save，再返回「发布终态事件」的任务；调用方随后 run 它。
            repository.save(failed);
            repository.afterCommit(() -> steps.add(FRAMEWORK_TERMINAL_EVENT));
            List<TransactionSynchronization> synchronizations = TransactionSynchronizationManager.getSynchronizations();
            synchronizations.forEach(TransactionSynchronization::afterCommit);
            synchronizations.forEach(synchronization ->
                    synchronization.afterCompletion(TransactionSynchronization.STATUS_COMMITTED));
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }

        assertEquals(List.of(
                ExecutionLifecycleProjection.STEP_CLOSE_CARDS,
                ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED,
                ExecutionLifecycleProjection.STEP_SAVE_USAGE,
                ExecutionLifecycleProjection.STEP_FINISH_TURN,
                ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT,
                FRAMEWORK_TERMINAL_EVENT), steps,
                "业务轮次收口必须早于框架终态事件，否则界面会先看到「已结束」再看到轮次收口");
    }

    @Test
    @DisplayName("仓储不再持有业务协作方，也没有 notify* 私有方法")
    void repositoryKeepsOnlyPersistenceAndFrameworkSignals() {
        Set<Class<?>> businessCollaborators = Set.of(ToolCallService.class, SubExecutionLifecycle.class,
                SessionContextUsageProjector.class, ChatTurnLifecycleProjector.class,
                ToolCallReadinessService.class,
                com.summit.core.conversation.event.RuntimeEventPublisher.class, InputWakeupService.class);

        Field[] fields = LocalExecutionRepository.class.getDeclaredFields();
        assertTrue(Arrays.stream(fields).noneMatch(field -> businessCollaborators.contains(field.getType())),
                "业务协作方必须只在 ExecutionLifecycleProjection 里，仓储直接持有就是把编排又塞回存储层");

        Method[] methods = LocalExecutionRepository.class.getDeclaredMethods();
        assertTrue(Arrays.stream(methods).noneMatch(method -> method.getName().startsWith("notify")),
                "挂起/终结/取消通知不得留在仓储里当私有方法，它们的顺序知识属于投影");
    }

    private void recordSteps() {
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_CLOSE_CARDS))
                .when(toolCalls).cancelPendingToolCalls(anyString());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_SUB_EXECUTION_FINISHED))
                .when(subExecution).onFinished(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_SAVE_USAGE))
                .when(usage).saveExecutionContextUsage(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_FINISH_TURN))
                .when(turns).finishExecution(any());
        doAnswer(invocation -> record(ExecutionLifecycleProjection.STEP_RESUME_PENDING_INPUT))
                .when(wakeups).resumeIfInputPending(anyLong());
    }

    private Object record(String step) {
        steps.add(step);
        return null;
    }

    private LocalExecutionRepository repository() {
        ExecutionCheckpointService checkpointService = mock(ExecutionCheckpointService.class);
        when(checkpointService.save(anyLong(), any(), anyInt(), anyString(), any(), any(), any()))
                .thenReturn(new ExecutionCheckpointService.SaveOutcome(true, null, true, false));
        when(checkpointService.clearClosurePending(anyLong())).thenReturn(true);
        ExecutionCheckpointStore store = mock(ExecutionCheckpointStore.class);
        ExecutionCheckpointStore.CheckpointWriter writer = mock(ExecutionCheckpointStore.CheckpointWriter.class);
        when(writer.fileId()).thenReturn("file-880");
        when(writer.stream()).thenReturn(java.io.OutputStream.nullOutputStream());
        when(store.begin(anyString())).thenReturn(writer);

        ExecutionLifecycleProjection projection = new ExecutionLifecycleProjection(
                provider(ToolCallReadinessService.class, mock(ToolCallReadinessService.class)),
                provider(ToolCallService.class, toolCalls),
                provider(SubExecutionLifecycle.class, subExecution),
                provider(SessionContextUsageProjector.class, usage),
                provider(ChatTurnLifecycleProjector.class, turns),
                provider(com.summit.core.conversation.event.RuntimeEventPublisher.class,
                        mock(com.summit.core.conversation.event.RuntimeEventPublisher.class)),
                provider(InputWakeupService.class, wakeups),
                provider(com.summit.dp.execution.domain.repository.ExecutionRepository.class,
                        mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class)));
        return new LocalExecutionRepository(checkpointService, new JsonConfig().objectMapper(), store,
                provider(ExecutionLifecycleProjection.class, projection), new MailReceiptFlusherStub());
    }

    private static Execution execution(ExecutionState state) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(SESSION_ID));
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

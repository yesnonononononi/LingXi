package com.summit.dp.task;

import com.summit.dp.shared.support.InputTestSupport;
import com.summit.dp.workflow.application.input.BackgroundTaskChannel;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.*;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class BackgroundTaskNotificationTest {
    private final TaskRepository repository = mock(TaskRepository.class);
    private final ExecutionResumeCoordinator coordinator = mock(ExecutionResumeCoordinator.class);
    private final BackgroundTaskNotifications notifications = new BackgroundTaskNotifications();
    private final BackgroundTaskLoopInterceptor interceptor =
            new BackgroundTaskLoopInterceptor(new BackgroundTaskChannel(repository, notifications));
    private final SubAgentWaitInterceptor wait = new SubAgentWaitInterceptor(InputTestSupport.background(repository, notifications));
    private final ObjectMapper json = new JsonConfig().objectMapper();

    @Test void bareModelReceivesBoundedResultAndCheckpointReceiptsSurviveCompaction() throws Exception {
        Task task = terminal(9007199254740993L, TaskStatus.FAILED, "x".repeat(3_000));
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(task));
        Execution execution = execution(100L, 10L, false);
        LoopContext context = context(execution);
        interceptor.onBeforeModelInvoke(context);
        assertEquals(1, execution.getMessages().size());
        assertEquals(false, assertInstanceOf(UserMessageEntity.class, execution.getMessages().getFirst())
                .getAttrs().get(UserMessageEntity.COMPACT));
        String notice = execution.getMessages().getFirst().text();
        assertTrue(notice.contains("taskId=9007199254740993"));
        assertTrue(notice.contains("status=FAILED, exitCode=7"));
        assertTrue(notice.contains("[摘要已截断]"));
        assertFalse(notice.contains("x".repeat(2_001)));
        assertTrue(wait.onBeforeComplete(context).next());

        Execution restored = json.readValue(json.writeValueAsBytes(execution), Execution.class);
        restored.getMessages().clear();
        interceptor.onBeforeModelInvoke(context(restored));
        assertTrue(restored.getMessages().isEmpty());
        assertEquals(List.of("9007199254740993"), restored.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes().get(BackgroundTaskNotifications.RECEIPTS));
        verifyNoInteractions(coordinator);
    }

    @Test void crashBeforeCheckpointDoesNotConsumeNoticeAndFailedAppendDoesNotRecordReceipt() throws Exception {
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(terminal(1L, TaskStatus.SUCCESS, "done")));
        Execution execution = execution(100L, 10L, false);
        byte[] lastCheckpoint = json.writeValueAsBytes(execution);
        interceptor.onBeforeModelInvoke(context(execution));
        Execution restored = json.readValue(lastCheckpoint, Execution.class);
        interceptor.onBeforeModelInvoke(context(restored));
        assertEquals(1, restored.getMessages().size());

        Execution failing = execution(100L, 10L, false);
        AtomicBoolean failAppend = new AtomicBoolean(true);
        LoopContext context = new LoopContext(LoopMessages.builder().execution(failing).build(),
                new ExecutionControlSignal("100"), 0, messages -> {
                    if (failAppend.get()) throw new ClientException("上下文追加失败");
                    failing.getMessages().addAll(messages);
                });
        assertThrows(ClientException.class, () -> interceptor.onBeforeModelInvoke(context));
        assertTrue(notifications.readReceipts(failing).isEmpty());
        failAppend.set(false);
        interceptor.onBeforeModelInvoke(context);
        assertEquals(1, failing.getMessages().size());
        assertFalse(interceptor.catchErr());
    }

    @Test void runningTaskRetainsRootAndChildWithoutBusyWakeups() {
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(task(1L)));
        for (boolean child : List.of(false, true)) {
            LoopContext context = context(execution(100L, 10L, child));
            assertFalse(wait.onBeforeComplete(context).next());
            assertEquals(LoopResult.Status.SUSPENDED, wait.onBeforeComplete(context).loopResult().status());
        }
        verifyNoInteractions(coordinator);
    }

    @Test void completionDuringModelInvocationContinuesWithoutAnotherWake() {
        Task task = task(1L);
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(task));
        LoopContext context = context(execution(100L, 10L, false));
        interceptor.onBeforeModelInvoke(context);
        task.finish(TaskStatus.CANCELLED, "stopped", 137, false);
        assertEquals(LoopResult.Status.CONTINUE, wait.onBeforeComplete(context).loopResult().status());
        verifyNoInteractions(coordinator);
        interceptor.onBeforeModelInvoke(context);
        assertTrue(wait.onBeforeComplete(context).next());
        assertTrue(context.getLoopMessages().getExecution().getMessages().getFirst().text().contains("CANCELLED"));
    }

    @Test void everyTerminalOutcomeIsDeliveredOnceAndDifferentExecutionDoesNotReceiveIt() {
        List<Task> tasks = new ArrayList<>();
        for (TaskStatus status : TaskStatus.values()) {
            if (status.isTerminal()) tasks.add(terminal((long) tasks.size() + 1L, status, status.name()));
        }
        when(repository.findByExecutionId(10L, 100L)).thenReturn(tasks);
        when(repository.findByExecutionId(10L, 101L)).thenReturn(List.of());
        when(repository.findByExecutionId(11L, 100L)).thenReturn(List.of());
        Execution owner = execution(100L, 10L, false);
        interceptor.onBeforeModelInvoke(context(owner));
        interceptor.onBeforeModelInvoke(context(owner));
        assertEquals(5, owner.getMessages().size());
        Execution next = execution(101L, 10L, false);
        interceptor.onBeforeModelInvoke(context(next));
        assertTrue(next.getMessages().isEmpty());
        assertTrue(wait.onBeforeComplete(context(next)).next());
        Execution other = execution(100L, 11L, false);
        interceptor.onBeforeModelInvoke(context(other));
        assertTrue(other.getMessages().isEmpty());
    }

    @Test void persistenceLookupFailureCannotSilentlyAllowCompletion() {
        when(repository.findByExecutionId(10L, 100L)).thenThrow(new ClientException("任务查询失败"));
        assertThrows(ClientException.class, () -> wait.onBeforeComplete(context(execution(100L, 10L, false))));
        assertFalse(interceptor.catchErr());
    }

    @Test void terminalWaitCannotMaskTheExistingCollaborationInputWakeup() {
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(task(1L)));
        EmailService email = mock(EmailService.class);
        when(email.pendingItemsUndelivered(10L, 7L)).thenReturn(List.of(EmailMessageVO.builder().id(2L).content("协作输入").build()));
        SubAgentWaitInterceptor collaboration = new SubAgentWaitInterceptor(InputTestSupport.collaboration(mock(SessionExecutionRegistry.class), email));
        Execution execution = execution(100L, 10L, false);
        execution.getAgentRequest().runtimeParametersOrDefault().setAttributes(
                Map.of(ExecutionAttributes.SESSION_ID, "10", ExecutionAttributes.AGENT_ID, "7"));
        DefaultLoopInterceptorProcessor processor = new DefaultLoopInterceptorProcessor(List.of(interceptor, collaboration));
        assertEquals(LoopResult.Status.CONTINUE, processor.onBeforeComplete(context(execution)).loopResult().status());
        verifyNoInteractions(coordinator);
        verify(email).pendingItemsUndelivered(10L, 7L);
    }

    @Test void realLoopProcessesCompletionInTheSameExecution() throws Exception {
        Task task = task(1L);
        when(repository.findByExecutionId(10L, 100L)).thenReturn(List.of(task));
        ToolExecutionManager tools = mock(ToolExecutionManager.class);
        when(tools.toolRegistry()).thenReturn(new ToolRegistry(List.of()));
        RuntimeBoundaryChecker boundary = mock(RuntimeBoundaryChecker.class);
        when(boundary.before(any(), any())).thenReturn(CheckPointResult.continueWith());
        ExecutionRepository checkpoints = mock(ExecutionRepository.class);
        AtomicReference<byte[]> snapshot = new AtomicReference<>();
        doAnswer(invocation -> {
            snapshot.set(json.writeValueAsBytes(invocation.getArgument(0)));
            return null;
        }).when(checkpoints).save(any());
        when(checkpoints.register("100")).thenReturn(new ExecutionControlSignal("100"));
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
        DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
        AtomicInteger modelCalls = new AtomicInteger();
        RuntimeProcessorTemplate runner = new RuntimeProcessorTemplate(RuntimeContext.builder()
                .conversationManager(new DefaultConversationManager(ContextAttachmentProvider.NONE))
                .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor(), interceptor, wait)))
                .runtimeBoundaryChecker(boundary).executionRepository(checkpoints)
                .toolExecutionManager(tools).runtimeEventPublisher(events)
                .runtimeLifeStyleManager(lifecycle)
                .executionControl(new DefaultExecutionController(() -> null, checkpoints, events, lifecycle))
                .usage(new ContextUsageReporter(new DefaultTokenizer(), 100_000, events, 1))
                .invoker(new DefaultChatModelInvoker(command -> {
                    int round = modelCalls.incrementAndGet();
                    long notices = command.getMessages().stream()
                            .filter(message -> message.text().contains("后台终端任务已结束：taskId=1")).count();
                    assertEquals(round == 1 ? 0L : 1L, notices);
                    if (round == 1) task.finish(TaskStatus.FAILED, "compile failed", 7, false);
                    return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder()
                                    .text(round == 1 ? "任务正在后台运行" : "编译失败，退出码为7").toolCalls(List.of()).build())
                            .tokenUsage(TokenUsageEntity.empty()).build();
                })).build());
        Execution execution = execution(100L, 10L, false);
        execution.setTokenUsage(TokenUsageEntity.empty());
        execution.setExecutionState(ExecutionState.CREATED);
        assertEquals(ExecutionState.COMPLETED, runner.execute(execution).getExecutionState());
        verifyNoInteractions(coordinator);
        assertNotNull(snapshot.get());
        Execution restored = json.readValue(snapshot.get(), Execution.class);
        assertEquals(2, modelCalls.get());
        assertEquals(ExecutionState.COMPLETED, restored.getExecutionState());
        assertEquals(2, restored.getMessages().stream().filter(AiMessageEntity.class::isInstance).count());
        assertTrue(notifications.readReceipts(restored).contains("1"));
        assertEquals("编译失败，退出码为7", restored.getAiMessage().getText());
    }

    private static Task task(long id) {
        return Task.builder().id(id).sessionId(10L).turnId(20L).executionId(100L).command("command").build();
    }

    private static Task terminal(long id, TaskStatus status, String output) {
        Task task = task(id);
        task.finish(status, output, 7, false);
        return task;
    }

    private static Execution execution(long id, long sessionId, boolean child) {
        Map<String, Object> attributes = child
                ? Map.of(ExecutionAttributes.SESSION_ID, Long.toString(sessionId), ExecutionAttributes.ROOT_EXECUTION_ID, "99")
                : Map.of(ExecutionAttributes.SESSION_ID, Long.toString(sessionId));
        return Execution.builder().id(Long.toString(id)).messages(new ArrayList<Message>())
                .agentRequest(AgentRequest.builder().runtimeParameters(
                        AgentRuntimeParameters.builder().attributes(attributes).build()).build()).build();
    }

    private static LoopContext context(Execution execution) {
        return new LoopContext(LoopMessages.builder().execution(execution).build(),
                new ExecutionControlSignal(execution.getId()), 0, execution.getMessages()::addAll);
    }
}

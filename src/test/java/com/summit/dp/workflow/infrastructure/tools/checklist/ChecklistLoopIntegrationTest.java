package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.exception.MaxStepsExceededException;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.runtime.loop.CheckPointResult;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.core.runtime.loop.RuntimeBoundaryChecker;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.loop.AgentLoopStepRunner;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

class ChecklistLoopIntegrationTest {
    private static final long SESSION = 6401L;
    private ChecklistTestDatabase fixture;
    private ChecklistService service;
    private ChecklistVO created;
    private final AtomicInteger calls = new AtomicInteger();
    private final AtomicInteger transcripts = new AtomicInteger();

    @BeforeEach
    void start() {
        fixture = ChecklistTestDatabase.start("checklist-loop");
        service = fixture.service();
        created = service.create(ChecklistCommand.create(SESSION, null, "执行", List.of("一步")));
    }

    @AfterEach
    void close() { fixture.close(); }

    @Test
    void aReminderActuallyCallsTheModelAgainAndThenClosesWithoutProgress() throws Exception {
        Execution execution = execution();
        LoopResult result = runner(command -> {
            int round = calls.incrementAndGet();
            if (round == 2) assertTrue(command.getMessages().stream()
                    .anyMatch(message -> message.text().contains("[lingxi-checklist-reminder:")));
            return response(List.of());
        }, List.of(reminder(new ChecklistReminderDelivery())), 2).run(execution, signal());

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, calls.get());
        assertEquals(2, transcripts.get());
        assertEquals(6, execution.getTokenUsage().getTotalTokens());
        assertEquals(ChecklistStatus.UNFINISHED, fixture.repository()
                .findByIdWithSteps(created.getChecklistId()).orElseThrow().getStatus());
    }

    @Test
    void theNextRoundCanUseTheActualUpdateExecutorAndCompleteNormally() throws Exception {
        Execution execution = execution();
        String args = "{\"checklistId\":" + created.getChecklistId() + ",\"stepId\":"
                + created.getSteps().getFirst().getStepId() + ",\"status\":\"COMPLETED\"}";
        LoopResult result = runner(command -> {
            int round = calls.incrementAndGet();
            return response(round == 2 ? List.of(new ToolCallRequest("update", ToolCatalog.UPDATE_CHECKLIST_STEP, 0, args)) : List.of());
        }, List.of(reminder(new ChecklistReminderDelivery())), 3).run(execution, signal());

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(3, calls.get());
        assertEquals(3, transcripts.get());
        assertEquals("COMPLETED", fixture.repository().findByIdWithSteps(created.getChecklistId())
                .orElseThrow().getStatus().name());
        assertEquals(1L, fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().getProgressVersion());
    }

    @Test
    void backgroundSuspensionHappensBeforeReminderConsumption() throws Exception {
        TaskRepository tasks = mock(TaskRepository.class);
        when(tasks.findByExecutionId(SESSION, 1001L)).thenReturn(List.of(Task.builder().id(1L).build()));
        BackgroundTaskNotifications notifications = mock(BackgroundTaskNotifications.class);
        when(notifications.readReceipts(any())).thenReturn(Set.of());
        BackgroundTaskLoopInterceptor background = new BackgroundTaskLoopInterceptor(tasks, notifications,
                mock(ExecutionResumeCoordinator.class));
        LoopResult result = runner(command -> { calls.incrementAndGet(); return response(List.of()); },
                List.of(reminder(new ChecklistReminderDelivery()), background), 3).run(execution(), signal());

        assertEquals(LoopResult.Status.SUSPENDED, result.status());
        assertEquals(1, calls.get());
        assertFalse(fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow().isRemindStatus());
    }

    @Test
    void cancellationDuringDeliveryWinsOverContinuation() throws Exception {
        ChecklistReminderDelivery cancelling = new ChecklistReminderDelivery() {
            public void append(LoopContext context, ReminderDecision decision) {
                super.append(context, decision);
                context.getSignal().requireSuspend();
                context.getSignal().requireCancel();
            }
        };
        LoopResult result = runner(command -> { calls.incrementAndGet(); return response(List.of()); },
                List.of(reminder(cancelling)), 2).run(execution(), signal());

        assertEquals(LoopResult.Status.CANCELLED, result.status());
        assertEquals(1, calls.get());
        assertEquals(ChecklistStatus.ACTIVE, fixture.repository()
                .findByIdWithSteps(created.getChecklistId()).orElseThrow().getStatus());
    }

    @Test
    void aReminderCannotInventAnExtraModelBudget() {
        assertThrows(MaxStepsExceededException.class, () -> runner(command -> {
            calls.incrementAndGet();
            return response(List.of());
        }, List.of(reminder(new ChecklistReminderDelivery())), 1).run(execution(), signal()));

        assertEquals(1, calls.get());
        assertEquals(ChecklistStatus.ACTIVE, fixture.repository()
                .findByIdWithSteps(created.getChecklistId()).orElseThrow().getStatus());
    }

    private ChecklistReminderInterceptor reminder(ChecklistReminderDelivery delivery) {
        return new ChecklistReminderInterceptor(service, new ChecklistContextInjector(service), delivery);
    }

    private AgentLoopStepRunner runner(ChatModel model, List<LoopInterceptor> business, int maxAttempts) {
        UpdateChecklistStepTool executor = new UpdateChecklistStepTool(new ObjectMapper().findAndRegisterModules(), service);
        ToolDefinition<?> definition = AnnotatedToolTestDefinitions.create(UpdateChecklistStepTool.class, executor);
        ToolExecutionManager tools = new ToolExecutionManager() {
            public List<ToolExecuteResult> execute(ToolExecuteCommand command) {
                List<ToolExecuteResult> results = new ArrayList<>();
                for (ToolCallRequest request : command.requests()) {
                    ToolExecuteResult result = executor.execute(ToolExecution.builder().id(request.id())
                            .executionId(command.executionId()).args(request.arguments()).attributes(command.attributes()).build());
                    assertTrue(result.isSuccess(), result.getToolOutput());
                    result.setId(request.id());
                    result.setRequestIndex(request.requestIndex());
                    result.setToolSpecification(definition);
                    results.add(result);
                }
                return results;
            }
            public ToolRegistry toolRegistry() { return new ToolRegistry(List.of(definition)); }
        };
        RuntimeBoundaryChecker boundary = new RuntimeBoundaryChecker() {
            public void checkModelAttempt(Execution execution) {
                if (execution.getModelAttempts() >= maxAttempts) throw new MaxStepsExceededException("测试预算耗尽");
            }
            public CheckPointResult before(Execution execution) {
                checkModelAttempt(execution);
                return CheckPointResult.continueWith();
            }
            public CheckPointResult after(Execution execution) { return CheckPointResult.continueWith(); }
        };
        List<LoopInterceptor> interceptors = new ArrayList<>(business);
        interceptors.add(new DefaultLoopInterceptor());
        return new AgentLoopStepRunner(RuntimeContext.builder()
                .conversationManager(new DefaultConversationManager((id, ai, results) -> transcripts.incrementAndGet(),
                        ContextAttachmentProvider.NONE))
                .runtimeBoundaryChecker(boundary).toolExecutionManager(tools)
                .runtimeEventPublisher(new RuntimeEventPublisher(List.of()))
                .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(interceptors))
                .invoker(new DefaultChatModelInvoker(model)).build());
    }

    private Execution execution() {
        return Execution.builder().id("1001").executionState(ExecutionState.RUNNING)
                .messages(new ArrayList<>(List.of(UserMessageEntity.from("执行任务"))))
                .tokenUsage(TokenUsageEntity.empty()).agentRequest(AgentRequest.builder()
                        .toolList(List.of(ToolCatalog.UPDATE_CHECKLIST_STEP))
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION))).build())
                        .build()).build();
    }

    private ExecutionControlSignal signal() { return new ExecutionControlSignal("1001"); }

    private ChatResponseEntity response(List<ToolCallRequest> calls) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text("执行结果").toolCalls(calls).build())
                .tokenUsage(TokenUsageEntity.of(3, 2, 1)).build();
    }
}

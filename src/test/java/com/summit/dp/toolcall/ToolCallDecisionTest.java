package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.impl.ApprovalFinalizer;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.impl.CommandOutcomeResolver;
import com.summit.dp.toolcall.application.service.impl.ApprovedCommandRestorer;
import com.summit.dp.toolcall.application.service.impl.ToolCallServiceImpl;
import com.summit.dp.toolcall.application.service.impl.ToolCallDecisionService;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * 决策链路回归：{@code PLAN} 单事务收尾 + {@code COMMAND} 两段式执行 + 幂等。
 *
 * <p>由旧 {@code InteractionCommandDecisionTest} / {@code CommandApprovalServiceTest} 演进而来，
 * 覆盖用户决策落定、执行恢复、以及「已处理不再重复执行」的不可逆保护。</p>
 */
class ToolCallDecisionTest {

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final ToolRegistry toolRegistry = mock(ToolRegistry.class);
    private final WorkspaceManager workspaces = mock(WorkspaceManager.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final SseEmitter emitter = mock(SseEmitter.class);
    private final CommandToolDefinitionExecutor commandExecutor = mock(CommandToolDefinitionExecutor.class);
    private final CountDownLatch finished = new CountDownLatch(1);
    /**
     * COMMAND 路径的 {@code resume} 由恢复协调器异步派发，SSE 结束不代表它已发生；
     * 断言「命令执行后父执行真的恢复」必须等这个信号，等 {@code emitter.complete()} 会漏判。
     */
    private final CountDownLatch resumed = new CountDownLatch(1);
    private final ObjectMapper mapper = new ObjectMapper();
    /** 恢复协调器的两张表在单测里只有桩：命令 T2 是否真的派发出去才是这些用例的断言点。 */
    private final ExecutionResumeTaskRepository resumeTaskRepository = mock(ExecutionResumeTaskRepository.class);
    private final com.summit.dp.execution.domain.repository.ExecutionRepository resumeExecutions =
            mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);

    private ToolCallServiceImpl service;
    private final List<ExecutionResumeCoordinator> coordinators = new ArrayList<>();

    @BeforeEach
    void setup() {
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            Consumer<TransactionStatus> action = invocation.getArgument(0);
            action.accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());

        when(sseEventPublisher.connect(anyLong())).thenReturn(emitter);
        when(executionIdentity.resolveRootSessionId(2L)).thenReturn(2L);
        doAnswer(invocation -> {
            finished.countDown();
            return null;
        }).when(emitter).complete();
        doAnswer(invocation -> { emitter.complete(); return null; }).when(sseEventPublisher).finish(emitter);

        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(toolCallRepository,
                new SessionAttributeRestorer(mock(SessionRepository.class)), modelContextService,
                provider(executionControl));
        ToolCallConverter converter = new ToolCallConverter(mapper);
        CommandApprovalExecutor commandApprovalExecutor = new CommandApprovalExecutor(toolCallRepository,
                converter, transactions,
                provider(executionControl), provider(executionRepository),
                new CommandOutcomeResolver(converter, runtimeEvents),
                new ApprovalFinalizer(toolCallRepository, converter, modelContextService,
                        runtimeEvents, transactions, provider(executionControl), resumer,
                        coordinator(resumer)),
                resumer,
                new ApprovedCommandRestorer(mapper, workspaces, provider(toolRegistry)),
                modelContextService,
                coordinator(resumer));
        service = new ToolCallServiceImpl(toolCallRepository,
                converter, transactions, commandApprovalExecutor,
                new ToolCallDecisionService(toolCallRepository, converter, executionIdentity,
                        modelContextService, sseEventPublisher, transactions,
                        provider(executionRepository), resumer),
                new CardAvailabilityPolicy(provider(executionRepository), provider(activity)),
                sseEventPublisher, executionIdentity);
        // 恢复协调器异步派发：任务行桩成「已入队可领取」，让命令 T2 真的走到 executionControl.resume。
        when(resumeTaskRepository.enqueue(anyLong(), anyLong(), any())).thenReturn(resumeTask());
        when(resumeTaskRepository.findByExecutionId(3L)).thenReturn(List.of(resumeTask()));
        when(resumeTaskRepository.claim(any())).thenReturn(true);
        when(resumeTaskRepository.updateState(any())).thenReturn(true);
        when(resumeExecutions.findResumeGeneration(3L)).thenReturn(1L);
        when(resumeExecutions.findSummariesByIds(any())).thenReturn(List.of(summary(ExecutionState.SUSPENDED)));
        // 决策事务提交后派发：单测无真事务，afterCommit 立即执行，让 accept 真的唤醒 worker。
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(executionRepository).afterCommit(any());
    }

    /**
     * 建一个真的恢复协调器：命令 T2 是否把父执行恢复回去正是这些用例的断言点，
     * 用 mock 协调器只能验到「派发被调用」，验不到恢复真的发生。
     * 登记下来在 {@code @AfterEach} 关闭，否则巡检线程会漏到后续测试类。
     */
    private ExecutionResumeCoordinator coordinator(SuspendedExecutionResumer resumer) {
        ExecutionResumeCoordinator coordinator = new ExecutionResumeCoordinator(resumeTaskRepository,
                resumeExecutions, resumer, executionControl, provider(executionRepository), provider(activity));
        coordinators.add(coordinator);
        return coordinator;
    }

    @AfterEach
    void shutdownCoordinators() {
        coordinators.forEach(ExecutionResumeCoordinator::close);
        coordinators.clear();
    }

    /** 供恢复协调器读取的挂起代摘要（不载 snapshot）。 */
    private com.summit.dp.execution.domain.model.Execution summary(ExecutionState state) {
        com.summit.dp.execution.domain.model.Execution summary =
                new com.summit.dp.execution.domain.model.Execution();
        summary.setId(3L);
        summary.setSessionId(2L);
        summary.setStatus(ExecutionStatusCodes.encode(state));
        summary.setResumeGeneration(1L);
        return summary;
    }

    private ExecutionResumeTask resumeTask() {
        return ExecutionResumeTask.builder().id(1L).executionId(3L).generation(1L)
                .state(ResumeTaskState.READY).version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    @Test
    void planApprovalCompletesCardWritesAnswerAndResumesInOneTransaction() throws Exception {
        ToolCall toolCall = promiseCall("call-plan", "create_plan",
                "{\"kind\":\"PLAN\",\"title\":\"T\",\"text\":\"body\"}");
        ToolMessageEntity toolMessage = ToolMessageEntity.builder().id("call-plan").name("create_plan").text("pending").build();
        Execution execution = execution("3", ExecutionState.SUSPENDED, toolMessage);

        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(toolCall));
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service.decide(2L, "call-plan", true, "可以");
        await();

        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
        assertTrue(toolCall.getRawOutput().contains("APPROVED"));
        assertEquals("可以", toolMessage.getText());
        verify(toolCallRepository).updateById(toolCall);
        verify(executionRepository).save(execution);
        // 上下文在事务内先写一次（结论落库），恢复后再写一次（loop 可能继续追加消息）。
        verify(modelContextService, atLeastOnce()).replace(eq(2L), any());
        verify(executionControl).resume(execution);
    }

    @Test
    void commandApprovalExecutesExactlyOnceThenResumes() throws Exception {
        ToolCall toolCall = commandCall("call-cmd");
        ToolMessageEntity toolMessage = ToolMessageEntity.builder().id("call-cmd").name("command").text("pending").build();
        Workspace workspace = workspace();
        Execution execution = execution("3", ExecutionState.SUSPENDED, toolMessage);
        ExecutionControlSignal signal = new ExecutionControlSignal("3");

        when(toolCallRepository.findById("call-cmd")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(workspace);
        when(commandExecutor.execute(any())).thenReturn(ToolExecuteResult.success("real output"));
        when(executionControl.resume(any(Execution.class))).thenAnswer(invocation -> {
            resumed.countDown();
            return execution;
        });

        service.decide(2L, "call-cmd", true, null);
        awaitResume();

        verify(commandExecutor, times(1)).execute(any());
        ArgumentCaptor<ToolExecution> replayedTool = ArgumentCaptor.forClass(ToolExecution.class);
        verify(commandExecutor).execute(replayedTool.capture());
        assertEquals(Map.of("turnId", "9001"), replayedTool.getValue().getEventMetaData());
        ArgumentCaptor<ToolCallEndEvent> replayedEvent = ArgumentCaptor.forClass(ToolCallEndEvent.class);
        verify(runtimeEvents).onToolCallOutput(replayedEvent.capture());
        assertEquals(Map.of("turnId", "9001"), replayedEvent.getValue().eventMetaData());
        assertTrue(toolMessage.getText().contains("real output"));
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
        assertTrue(toolCall.getRawOutput().contains("APPROVED"));
        verify(executionRepository).unregister(signal);
        verify(executionControl).resume(execution);
    }

    @Test
    void commandRejectionNeverExecutesButResumes() throws Exception {
        ToolCall toolCall = commandCall("call-rej");
        ToolMessageEntity toolMessage = ToolMessageEntity.builder().id("call-rej").name("command").text("pending").build();
        Execution execution = execution("3", ExecutionState.SUSPENDED, toolMessage);
        ExecutionControlSignal signal = new ExecutionControlSignal("3");

        when(toolCallRepository.findById("call-rej")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        when(executionControl.resume(any(Execution.class))).thenAnswer(invocation -> {
            resumed.countDown();
            return execution;
        });

        service.decide(2L, "call-rej", false, null);
        awaitResume();

        verifyNoInteractions(commandExecutor, workspaces, toolRegistry);
        assertTrue(toolMessage.getText().contains("拒绝"));
        assertTrue(toolCall.getRawOutput().contains("REJECTED"));
        verify(executionControl).resume(execution);
    }

    @Test
    void alreadyDecidedCardIsANoOp() {
        ToolCall done = commandCall("call-done");
        done.complete("{\"outcome\":\"APPROVED\"}");
        when(toolCallRepository.findById("call-done")).thenReturn(Optional.of(done));

        service.decide(2L, "call-done", true, null);

        verifyNoInteractions(executionRepository, executionControl, commandExecutor);
        verify(toolCallRepository, never()).updateById(any());
    }

    @Test
    void preparingAndActiveExecutionsCannotAcceptDecision() {
        ToolCall preparing = commandCall("call-preparing").toBuilder().status(ToolCallStatus.PREPARING).build();
        when(toolCallRepository.findById(preparing.getId())).thenReturn(Optional.of(preparing));
        assertThrows(ClientException.class, () -> service.decide(2L, preparing.getId(), true, null));

        ToolCall waiting = commandCall("call-active");
        when(toolCallRepository.findById(waiting.getId())).thenReturn(Optional.of(waiting));
        when(activity.isActive("3")).thenReturn(true);
        assertThrows(ClientException.class, () -> service.decide(2L, waiting.getId(), true, null));
        verifyNoInteractions(executionRepository, executionControl, commandExecutor);
        verify(toolCallRepository, never()).updateById(any());
    }

    @Test
    void remainingPreparingAndDelegationSlotsPreventEarlyResume() throws Exception {
        ToolCall plan = promiseCall("call-plan", "create_plan", "{\"kind\":\"PLAN\",\"text\":\"计划\"}");
        ToolCall preparing = commandCall("call-preparing").toBuilder().status(ToolCallStatus.PREPARING).build();
        ToolCall delegation = promiseCall("call-child", "call_sub_agent", "{\"kind\":\"DELEGATION\"}");
        ToolMessageEntity slot = ToolMessageEntity.builder().id(plan.getId()).name(plan.getToolName()).text("pending").build();
        Execution execution = execution("3", ExecutionState.SUSPENDED, slot);
        when(toolCallRepository.findById(plan.getId())).thenReturn(Optional.of(plan));
        when(toolCallRepository.listUnresolvedByExecutionId(3L)).thenReturn(List.of(preparing, delegation));
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));

        service.decide(2L, plan.getId(), true, "可以");
        await();
        assertEquals(ToolCallStatus.COMPLETED, plan.getStatus());
        verify(executionControl, never()).resume(any(Execution.class));
    }

    @Test
    void publicationFailureDoesNotUndoCommittedDecision() throws Exception {
        ToolCall plan = promiseCall("call-plan", "create_plan", "{\"kind\":\"PLAN\",\"text\":\"计划\"}");
        ToolMessageEntity slot = ToolMessageEntity.builder().id(plan.getId()).name(plan.getToolName()).text("pending").build();
        Execution execution = execution("3", ExecutionState.SUSPENDED, slot);
        when(toolCallRepository.findById(plan.getId())).thenReturn(Optional.of(plan));
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);
        // 广播通道故障不得回滚已提交的决策与恢复派发。
        doThrow(new IllegalStateException("broadcast failed")).when(sseEventPublisher).publish(anyLong(), any());

        assertDoesNotThrow(() -> service.decide(2L, plan.getId(), true, "可以"));
        await();
        assertEquals(ToolCallStatus.COMPLETED, plan.getStatus());
        verify(executionControl).resume(execution);
    }

    @Test
    void cancelledExecutionRejectsApprovalBeforeRegistering() {
        // stop 与「点批准」竞争：执行已随停止被取消，但卡片行还停在 pending 的竞争窗口。
        ToolCall toolCall = commandCall("call-stopped");
        Execution cancelled = execution("3", ExecutionState.CANCELLED);

        when(toolCallRepository.findById("call-stopped")).thenReturn(Optional.of(toolCall));
        when(executionRepository.findById("3")).thenReturn(Optional.of(cancelled));

        ClientException rejected = assertThrows(ClientException.class,
                () -> service.decide(2L, "call-stopped", true, null));

        assertTrue(rejected.getMessage().contains("执行尚未暂停或已结束"));
        // 未登记控制信号、未收口卡片、未恢复执行 —— 卡片留给 stop 路径统一取消
        verify(executionRepository, never()).register(any());
        verify(toolCallRepository, never()).updateById(any());
        verify(executionControl, never()).resume(any(Execution.class));
    }

    private void await() throws Exception {
        assertTrue(finished.await(5, TimeUnit.SECONDS));
    }

    /** 等异步恢复真的发生；命令链路的 resume 由协调器派发，SSE 结束早于它。 */
    private void awaitResume() throws Exception {
        assertTrue(finished.await(5, TimeUnit.SECONDS));
        assertTrue(resumed.await(10, TimeUnit.SECONDS), "命令 T2 之后父执行应被协调器恢复");
    }

    private ToolCall promiseCall(String id, String toolName, String content) {
        return ToolCall.builder().id(id).conversationId(2L).executionId(3L).toolName(toolName)
                .type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content(content).rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private ToolCall commandCall(String id) {
        String content = "{\"kind\":\"COMMAND\",\"command\":\"echo hi\",\"workDir\":\"/project\","
                + "\"shell\":\"BASH\",\"workspaceId\":\"workspace\",\"args\":\"{\\\"command\\\":\\\"echo hi\\\"}\"}";
        return ToolCall.builder().id(id).conversationId(2L).executionId(3L).toolName("command")
                .type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("命令审批").content(content).rawInput("{\"args\":{\"command\":\"echo hi\"}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private Workspace workspace() {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.shellType()).thenReturn(ShellType.BASH);
        return workspace;
    }

    private ToolDefinition<CommandToolDefinitionExecutor> commandTool() {
        return ToolDefinition.<CommandToolDefinitionExecutor>builder()
                .id("command").name("command").maxOutput(1000).timeout(30L)
                .executor(commandExecutor).build();
    }

    private Execution execution(String id, ExecutionState state, Message... messages) {
        List<Message> context = new ArrayList<>(List.of(messages));
        List<ToolCallRequest> requests = new ArrayList<>();
        for (Message message : context) {
            if (message instanceof ToolMessageEntity tool) {
                requests.add(ToolCallRequest.builder().id(String.valueOf(tool.getId())).name(tool.getName())
                        .requestIndex(requests.size()).arguments("{}").build());
            }
        }
        if (!requests.isEmpty()) context.addFirst(AiMessageEntity.builder().toolCalls(requests).build());
        return Execution.builder().id(id).lastResponseId("9007199254740993").executionState(state)
                .agentRequest(AgentRequest.builder().workspaceSpec(mock(WorkspaceSpec.class))
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .eventMetaData(Map.of("turnId", "9001"))
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, "2")).build())
                        .build())
                .messages(context).build();
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }
}

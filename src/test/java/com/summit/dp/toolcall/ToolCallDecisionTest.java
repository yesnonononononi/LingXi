package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
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
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.impl.ToolCallServiceImpl;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.List;
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
    private final ToolRegistry toolRegistry = mock(ToolRegistry.class);
    private final WorkspaceManager workspaces = mock(WorkspaceManager.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ToolCallEventPublisher toolCallEventPublisher = mock(ToolCallEventPublisher.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final SseEmitter emitter = mock(SseEmitter.class);
    private final CommandToolDefinitionExecutor commandExecutor = mock(CommandToolDefinitionExecutor.class);
    private final CountDownLatch finished = new CountDownLatch(1);
    private final ObjectMapper mapper = new ObjectMapper();

    private ToolCallServiceImpl service;

    @BeforeEach
    void setup() {
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            Consumer<TransactionStatus> action = invocation.getArgument(0);
            action.accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());

        when(sseEventPublisher.connect(anyLong())).thenReturn(emitter);
        when(executionIdentity.rootSessionIdOfSession(2L)).thenReturn(2L);
        doAnswer(invocation -> {
            finished.countDown();
            return null;
        }).when(emitter).complete();

        CommandApprovalExecutor commandApprovalExecutor = new CommandApprovalExecutor(toolCallRepository,
                new ToolCallConverter(mapper), sseEventPublisher, executionIdentity, modelContextService,
                runtimeEvents, workspaces, transactions, mapper,
                provider(executionControl), provider(executionRepository), provider(toolRegistry),
                new SessionAttributeRestorer(mock(SessionRepository.class)));
        service = new ToolCallServiceImpl(toolCallRepository,
                new ToolCallConverter(mapper), executionIdentity, modelContextService, sseEventPublisher,
                toolCallEventPublisher, transactions,
                provider(executionControl), provider(executionRepository), commandApprovalExecutor,
                new SessionAttributeRestorer(mock(SessionRepository.class)));
    }

    @Test
    void planApprovalCompletesCardWritesAnswerAndResumesInOneTransaction() {
        ToolCall toolCall = promiseCall("call-plan", "create_plan",
                "{\"kind\":\"PLAN\",\"title\":\"T\",\"text\":\"body\"}");
        ToolMessageEntity toolMessage = ToolMessageEntity.builder().id("call-plan").name("create_plan").text("pending").build();
        Execution execution = execution("3", ExecutionState.SUSPENDED, toolMessage);

        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(toolCall));
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service.decide(2L, "call-plan", true, "可以");

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
        when(workspaces.acquire(any(com.summit.core.workspace.WorkspaceSpec.class))).thenReturn(workspace);
        when(commandExecutor.execute(any())).thenReturn(ToolExecuteResult.success("real output"));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service.decide(2L, "call-cmd", true, null);
        await();

        verify(commandExecutor, times(1)).execute(any());
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
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service.decide(2L, "call-rej", false, null);
        await();

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

    private void await() throws Exception {
        assertTrue(finished.await(5, TimeUnit.SECONDS));
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
        return Execution.builder().id(id).executionState(state)
                .agentRequest(AgentRequest.builder().workspaceSpec(mock(com.summit.core.workspace.WorkspaceSpec.class))
                        .runtimeParameters(com.summit.core.agent.AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, "2")).build())
                        .build())
                .messages(new java.util.ArrayList<>(List.of(messages))).build();
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }
}

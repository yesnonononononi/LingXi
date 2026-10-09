package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.loop.ApprovalOutcome;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ApprovalFinalizer;
import com.summit.dp.toolcall.application.service.impl.ApprovedCommandRestorer;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.impl.CommandOutcomeResolver;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link CommandApprovalExecutor} 的安全护栏与收口回归。
 *
 * <p>覆盖两类不变量：审批期间环境被替换则拒绝重放（命令绝不落地）；以及命令执行链的
 * 取消与「异步派发失败」两条收口路径——无论哪条，控制槽位都不能泄漏、执行都不能卡在
 * RUNNING。</p>
 */
class CommandApprovalExecutorTest {

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ToolRegistry toolRegistry = mock(ToolRegistry.class);
    private final WorkspaceManager workspaces = mock(WorkspaceManager.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final CommandToolDefinitionExecutor commandExecutor = mock(CommandToolDefinitionExecutor.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);

    private TransactionTemplate transactions;
    private SuspendedExecutionResumer resumer;
    private CommandApprovalExecutor executor;

    @BeforeEach
    void setup() {
        transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            Consumer<TransactionStatus> action = invocation.getArgument(0);
            action.accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());

        resumer = new SuspendedExecutionResumer(toolCallRepository,
                new SessionAttributeRestorer(mock(SessionRepository.class)), modelContextService,
                provider(executionControl));
        // 模拟框架控制：beginApproval 把执行从挂起推入运行；finishApproval(CANCELLED) / failApproval 收口。
        doAnswer(invocation -> {
            ((Execution) invocation.getArgument(0)).resumeChecked();
            return null;
        }).when(executionControl).beginApproval(any(Execution.class));
        doAnswer(invocation -> {
            Execution target = invocation.getArgument(0);
            ApprovalOutcome outcome = invocation.getArgument(1);
            if (outcome == ApprovalOutcome.CANCELLED) {
                target.cancelChecked();
            }
            return null;
        }).when(executionControl).finishApproval(any(Execution.class), any(ApprovalOutcome.class));
        doAnswer(invocation -> {
            ((Execution) invocation.getArgument(0)).failChecked(invocation.getArgument(1));
            return null;
        }).when(executionControl).failApproval(any(Execution.class), anyString());

        executor = buildExecutor();
    }

    private CommandApprovalExecutor buildExecutor() {
        return new CommandApprovalExecutor(toolCallRepository,
                new ToolCallConverter(mapper), transactions,
                provider(executionControl), provider(executionRepository),
                new CommandOutcomeResolver(new ToolCallConverter(mapper), runtimeEvents),
                new ApprovalFinalizer(toolCallRepository, new ToolCallConverter(mapper), modelContextService,
                        runtimeEvents, transactions, provider(executionControl), resumer, resumeCoordinator),
                resumer,
                new ApprovedCommandRestorer(mapper, workspaces, provider(toolRegistry)),
                modelContextService,
                resumeCoordinator);
    }

    @Test
    void approvedCommandEventsRetainOriginalPositionFromLegacyModelList() throws Exception {
        ToolCall toolCall = commandCall("call-second", "echo hi", "echo hi");
        AiMessageEntity original = AiMessageEntity.builder().toolCalls(List.of(
                ToolCallRequest.builder().id("call-first").name("read").arguments("{}").build(),
                ToolCallRequest.builder().id("call-second").name("command").arguments("{}").build())).build();
        Execution execution = execution("3", original,
                ToolMessageEntity.builder().id("call-second").name("command").text("pending").build());
        ExecutionControlSignal signal = new ExecutionControlSignal("3");
        when(toolCallRepository.findById("call-second")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace approvedWorkspace = workspace("workspace");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(approvedWorkspace);
        when(commandExecutor.execute(any())).thenReturn(ToolExecuteResult.success("已执行"));

        CountDownLatch finished = new CountDownLatch(1);
        executor.decide(toolCall, true, null, null, finished::countDown);
        assertTrue(finished.await(5, TimeUnit.SECONDS));
        ArgumentCaptor<ToolCallStartEvent> start = ArgumentCaptor.forClass(ToolCallStartEvent.class);
        ArgumentCaptor<ToolCallEndEvent> end = ArgumentCaptor.forClass(ToolCallEndEvent.class);
        verify(runtimeEvents).onToolCall(start.capture());
        verify(runtimeEvents).onToolCallOutput(end.capture());
        assertEquals(1, start.getValue().getRequestIndex());
        assertEquals(1, end.getValue().getRequestIndex());
        assertEquals("call-second", start.getValue().getRequestId());
        assertEquals("call-second", end.getValue().getRequestId());
    }

    @Test
    void rejectsReplayWhenWorkspaceChangedSinceApproval() {
        ToolCall toolCall = commandCall("call-ws", "echo hi", "echo hi");
        Execution execution = execution("3", ToolMessageEntity.builder().id("call-ws").name("command").text("pending").build());
        ExecutionControlSignal signal = new ExecutionControlSignal("3");

        when(toolCallRepository.findById("call-ws")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        // 审批期间工作空间被换成了另一个 id
        Workspace otherWorkspace = workspace("other");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(otherWorkspace);

        ClientException ex = assertThrows(ClientException.class, () -> executor.decide(toolCall, true, null, null, null));

        assertTrue(ex.getMessage().contains("命令执行环境已变化"));
        verify(commandExecutor, never()).execute(any());
    }

    @Test
    void rejectsReplayWhenApprovedCommandDiffersFromSnapshot() {
        ToolCall toolCall = commandCall("call-args", "echo hi", "echo bye");
        Execution execution = execution("3", ToolMessageEntity.builder().id("call-args").name("command").text("pending").build());
        ExecutionControlSignal signal = new ExecutionControlSignal("3");

        when(toolCallRepository.findById("call-args")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace matchedWorkspace = workspace("workspace");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(matchedWorkspace);

        ClientException ex = assertThrows(ClientException.class, () -> executor.decide(toolCall, true, null, null, null));

        assertTrue(ex.getMessage().contains("命令审批参数不一致"));
        verify(commandExecutor, never()).execute(any());
    }

    @Test
    @DisplayName("命令执行期间被取消：命令不执行，执行收成 CANCELLED，控制槽位被释放")
    void cancelDuringCommandApprovalSkipsCommandAndReleasesSlot() throws Exception {
        ToolCall toolCall = commandCall("call-cancel", "echo hi", "echo hi");
        Execution execution = execution("3", ToolMessageEntity.builder().id("call-cancel").name("command").text("pending").build());
        // 控制信号在收尾前被异步置成「要求取消」：命令尚未执行，必须就地取消。
        ExecutionControlSignal signal = new ExecutionControlSignal("3");
        signal.requireCancel();

        when(toolCallRepository.findById("call-cancel")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace approvedWorkspace = workspace("workspace");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(approvedWorkspace);

        CountDownLatch finished = new CountDownLatch(1);
        executor.decide(toolCall, true, null, null, finished::countDown);

        assertTrue(finished.await(5, TimeUnit.SECONDS), "收尾回调必须被触发（v1 靠它关流）");
        verify(commandExecutor, never()).execute(any());
        verify(executionRepository).unregister(signal);
        assertEquals(ExecutionState.CANCELLED, execution.getExecutionState(), "取消路径必须把执行收口成终态");
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
        assertTrue(toolCall.getRawOutput().contains("CANCELLED"));
    }

    @Test
    @DisplayName("异步派发失败：执行被收成失败且控制槽位被释放，不留 RUNNING 泄漏")
    void dispatchFailureStillSettlesExecutionAndReleasesSlot() {
        ToolCall toolCall = commandCall("call-dispatch", "echo hi", "echo hi");
        Execution execution = execution("3", ToolMessageEntity.builder().id("call-dispatch").name("command").text("pending").build());
        ExecutionControlSignal signal = new ExecutionControlSignal("3");

        when(toolCallRepository.findById("call-dispatch")).thenReturn(Optional.of(toolCall));
        when(executionRepository.register("3")).thenReturn(signal);
        when(executionRepository.findById("3")).thenReturn(Optional.of(execution));
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace approvedWorkspace = workspace("workspace");
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(approvedWorkspace);

        // 派发线程池不可用：T1 已提交，收尾永远起不来。
        CommandApprovalExecutor failing = new CommandApprovalExecutor(toolCallRepository,
                new ToolCallConverter(mapper), transactions,
                provider(executionControl), provider(executionRepository),
                new CommandOutcomeResolver(new ToolCallConverter(mapper), runtimeEvents),
                new ApprovalFinalizer(toolCallRepository, new ToolCallConverter(mapper), modelContextService,
                        runtimeEvents, transactions, provider(executionControl), resumer, resumeCoordinator),
                resumer,
                new ApprovedCommandRestorer(mapper, workspaces, provider(toolRegistry)),
                modelContextService,
                resumeCoordinator) {
            @Override
            protected void dispatchAsync(Runnable task) {
                throw new IllegalStateException("派发线程池不可用");
            }
        };

        assertThrows(IllegalStateException.class, () -> failing.decide(toolCall, true, null, null, null));

        verify(commandExecutor, never()).execute(any());
        verify(executionRepository).unregister(signal);
        verify(executionControl).failApproval(eq(execution), anyString());
        assertEquals(ExecutionState.FAILED, execution.getExecutionState(), "派发失败必须收口执行，不能停在 RUNNING");
        assertEquals(ToolCallStatus.COMPLETED, toolCall.getStatus());
        assertTrue(toolCall.getRawOutput().contains("FAILED"));
    }

    private ToolCall commandCall(String id, String snapshotCommand, String argsCommand) {
        String approvedArgs = "{\"command\":\"" + argsCommand + "\"}";
        String escapedArgs = approvedArgs.replace("\"", "\\\"");
        String content = "{\"kind\":\"COMMAND\",\"command\":\"" + snapshotCommand + "\","
                + "\"workDir\":\"/project\",\"shell\":\"BASH\",\"workspaceId\":\"workspace\","
                + "\"args\":\"" + escapedArgs + "\"}";
        return ToolCall.builder().id(id).conversationId(2L).executionId(3L).toolName("command")
                .type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("命令审批").content(content).rawInput("{\"args\":{\"command\":\"" + argsCommand + "\"}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private Workspace workspace(String id) {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn(id);
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

    private Execution execution(String id, Message... messages) {
        List<Message> context = new ArrayList<>(List.of(messages));
        if (context.stream().noneMatch(AiMessageEntity.class::isInstance)) {
            List<ToolCallRequest> requests = context.stream().filter(ToolMessageEntity.class::isInstance)
                    .map(ToolMessageEntity.class::cast).map(tool -> ToolCallRequest.builder()
                            .id(String.valueOf(tool.getId())).name(tool.getName()).arguments("{}").build()).toList();
            context.addFirst(AiMessageEntity.builder().toolCalls(requests).build());
        }
        return Execution.builder().id(id).executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder().workspaceSpec(mock(WorkspaceSpec.class))
                        .runtimeParameters(com.summit.core.agent.AgentRuntimeParameters.builder()
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

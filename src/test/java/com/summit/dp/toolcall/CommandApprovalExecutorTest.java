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
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link CommandApprovalExecutor} 的安全护栏回归（评审 P1-① 拆出后的命令执行专属测试）。
 *
 * <p>覆盖 {@code restoreCall} 的「审批期间环境被替换则拒绝重放」约束：工作空间变化、批准命令与
 * 审批快照不一致时都必须拒绝执行（命令绝不落地）。</p>
 */
class CommandApprovalExecutorTest {

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ToolRegistry toolRegistry = mock(ToolRegistry.class);
    private final WorkspaceManager workspaces = mock(WorkspaceManager.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final SseEmitter emitter = mock(SseEmitter.class);
    private final CommandToolDefinitionExecutor commandExecutor = mock(CommandToolDefinitionExecutor.class);
    private final ObjectMapper mapper = new ObjectMapper();

    private CommandApprovalExecutor executor;

    @BeforeEach
    void setup() {
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        when(sseEventPublisher.connect(anyLong())).thenReturn(emitter);
        when(executionIdentity.rootSessionIdOfSession(2L)).thenReturn(2L);
        executor = new CommandApprovalExecutor(toolCallRepository, new ToolCallConverter(mapper),
                sseEventPublisher, executionIdentity, modelContextService, runtimeEvents,
                transactions, provider(executionControl), provider(executionRepository),
                new SessionAttributeRestorer(mock(SessionRepository.class)),
                new com.summit.dp.toolcall.application.service.impl.ApprovedCommandRestorer(mapper, workspaces,
                        provider(toolRegistry)));
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

        ClientException ex = assertThrows(ClientException.class, () -> executor.decide(toolCall, true, null));

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

        ClientException ex = assertThrows(ClientException.class, () -> executor.decide(toolCall, true, null));

        assertTrue(ex.getMessage().contains("命令审批参数不一致"));
        verify(commandExecutor, never()).execute(any());
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
        return Execution.builder().id(id).executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder().workspaceSpec(mock(WorkspaceSpec.class))
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

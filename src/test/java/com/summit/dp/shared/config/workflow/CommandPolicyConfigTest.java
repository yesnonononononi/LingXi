package com.summit.dp.shared.config.workflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CommandApprovalRegistrar;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.*;

class CommandPolicyConfigTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final ToolCallRegistrar registrar = mock(ToolCallRegistrar.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final ToolCallConverter converter = new ToolCallConverter(mapper);
    private final CommandApprovalRegistrar approvalRegistrar =
            new CommandApprovalRegistrar(registrar, converter);
    private final ToolExecutionPolicy policy = new CommandPolicyConfig()
            .commandApprovalPolicy(mapper, approvalRegistrar);

    private ToolExecution command(String executionId, String command, CommandApprovalPolicy mode) throws Exception {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.shellType()).thenReturn(ShellType.BASH);
        Map<String, Object> attributes = new HashMap<>(CommandApprovalPolicy.toAttributes(mode));
        attributes.put(ExecutionAttributes.SESSION_ID, executionId);
        return ToolExecution.builder().workspace(workspace).executionId(executionId).id("tool-1")
                .toolDefinition(ToolDefinition.<CommandToolDefinitionExecutor>builder()
                        .id("command").name("command").maxOutput(1000).timeout(30L)
                        .executor(new CommandToolDefinitionExecutor(mapper)).build())
                .args(mapper.writeValueAsString(Map.of("command", command)))
                .attributes(attributes).build();
    }

    @Test
    void approvalAlwaysSuspendsInsteadOfGrantingModelReplay() throws Exception {
        assertTrue(policy.beforeExecution(command("1", "echo approved", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
        assertTrue(policy.beforeExecution(command("1", "echo approved", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
    }

    @Test
    void approvalRegistersExactlyOnePromiseCard() throws Exception {
        ToolExecution execution = command("1", "echo test", CommandApprovalPolicy.PRE_EXEC_CONFIRM);
        execution.setAttributes(Map.of(ExecutionAttributes.SESSION_ID, "1",
                CommandApprovalPolicy.ATTRIBUTE_KEY, "PRE_EXEC_CONFIRM",
                "command.approval.granted-command", "echo test"));
        assertTrue(policy.beforeExecution(execution).isPromise());
        // 卡片载荷登记为一条 PROMISE（kind=COMMAND），SSE 只发「有新卡片」通知。
        verify(registrar).registerPromise(argThat(cmd -> "tool-1".equals(cmd.toolCallId())
                && cmd.kind() == ToolCallKind.COMMAND && "command".equals(cmd.toolName())));
    }

    @Test
    void destructiveCommandsAreBlocked() throws Exception {
        assertFalse(policy.beforeExecution(command("1", "shutdown now", CommandApprovalPolicy.FULL_ACCESS)).isSuccess());
        verifyNoInteractions(registrar);
    }

    @Test
    void destructiveCommandsAreBlockedForUnixAndUnknownShell() {
        assertEquals(com.summit.dp.tools.baseTools.terminal.CommandGuard.Verdict.DESTRUCTIVE,
                com.summit.dp.tools.baseTools.terminal.CommandGuard.assess("rm -rf /tmp/approval-audit",
                        com.summit.core.runtime.workspace.ShellType.BASH));
        assertEquals(com.summit.dp.tools.baseTools.terminal.CommandGuard.Verdict.DESTRUCTIVE,
                com.summit.dp.tools.baseTools.terminal.CommandGuard.assess("Clear-Disk -Number 99", null));
    }

    @Test
    void policyModesAreRespected() throws Exception {
        assertNull(policy.beforeExecution(command("1", "echo test", CommandApprovalPolicy.DANGEROUS_BLOCK)));
        assertNull(policy.beforeExecution(command("1", "npm install", CommandApprovalPolicy.FULL_ACCESS)));
        assertTrue(policy.beforeExecution(command("1", "npm install", CommandApprovalPolicy.DANGEROUS_BLOCK)).isPromise());
        assertTrue(policy.beforeExecution(command("1", "echo test", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
    }
}

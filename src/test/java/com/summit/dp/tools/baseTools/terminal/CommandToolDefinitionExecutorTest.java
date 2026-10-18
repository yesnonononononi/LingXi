package com.summit.dp.tools.baseTools.terminal;

import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 终端执行器的所有返回路径都必须把模型声明的 {@code intention} 放进 toolMetaData
 * （随 ToolCallEndEvent.metaData 广播）；模型未填时省略键，绝不放 null 值。
 */
class CommandToolDefinitionExecutorTest {

    private final CommandToolDefinitionExecutor executor =
            new CommandToolDefinitionExecutor(new ObjectMapper());

    @Test
    void rawModelCommandIsPassedToBridgeWithoutBusinessShellWrapping() throws Exception {
        String command = "$value = 'A B'; Write-Output $value | Select-Object -First 1";
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        // 自定义 Bridge 负责 shell，业务执行路径只需要输出编码。
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder()
                .charset(StandardCharsets.UTF_8).build());
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.commands()).thenReturn(commands);
        when(workspace.workDir()).thenReturn(".");
        when(commands.execute(anyString(), eq("."), eq(StandardCharsets.UTF_8), eq(1L), eq(TimeUnit.SECONDS), eq(100L)))
                .thenReturn(new WorkspaceCommands.CommandResult(0, "A B", false, false));
        ToolDefinition<?> definition = ToolDefinition.builder().id("execute_command").name("execute_command")
                .timeout(1L).maxOutput(100).executor(executor).build();

        ToolExecuteResult result = executor.process(ExecuteCommandRequest.builder().command(command).build(),
                workspace, definition);

        assertTrue(result.isSuccess());
        verify(commands).execute(command, ".", StandardCharsets.UTF_8, 1L, TimeUnit.SECONDS, 100L);
    }

    @Test
    void destructiveRefusalCarriesIntention() {
        ToolExecuteResult result = executor.execute(execution("rm -rf /", "清空根目录"));

        assertFalse(result.isSuccess());
        assertEquals("清空根目录", result.getToolMetaData().get(ExecuteCommandRequest.INTENTION));
    }

    @Test
    void blankCommandWithoutIntentionOmitsTheKey() {
        ToolExecuteResult result = executor.execute(execution("  ", null));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolMetaData() == null || result.getToolMetaData().isEmpty());
    }

    @Test
    void interruptIsReportedAsInterruptedAndKeepsItsMark() throws Exception {
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder()
                .shellType(ShellType.BASH).charset(StandardCharsets.UTF_8).build());
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.commands()).thenReturn(commands);
        when(workspace.workDir()).thenReturn(".");
        when(commands.execute(anyString(), eq("."), eq(StandardCharsets.UTF_8), eq(240L), eq(TimeUnit.SECONDS), eq(100L)))
                .thenThrow(new InterruptedException("stop requested"));

        ToolExecuteResult result = executor.execute(execution("sleep 600", "长时间等待", workspace));

        assertFalse(result.isSuccess());
        assertTrue(Thread.currentThread().isInterrupted(), "打断标记必须保留，否则上层看不到取消");
        Thread.interrupted();
        assertEquals("command interrupted before it completed", result.getToolOutput());
    }

    private ToolExecution execution(String command, String intention, Workspace workspace) {
        ExecuteCommandRequest request = ExecuteCommandRequest.builder().command(command).intention(intention).build();
        ToolDefinition<?> definition = ToolDefinition.builder().id("execute_command").name("execute_command")
                .maxOutput(100).timeout(240L).executor(executor).build();
        return ToolExecution.builder()
                .id("call-1")
                .toolDefinition(definition)
                .executionId("1")
                .turnId("1")
                .workspace(workspace)
                .args(toJson(request))
                .build();
    }

    private ToolExecution execution(String command, String intention) {
        ExecuteCommandRequest request = ExecuteCommandRequest.builder().command(command).intention(intention).build();
        ToolDefinition<?> definition = ToolDefinition.builder().id("execute_command").name("execute_command")
                .maxOutput(100).timeout(1L).executor(executor).build();
        Workspace workspace = new Workspace() {
            @Override
            public String id() {
                return "w";
            }

            @Override
            public RuntimeEnvironment runtimeEnvironment() {
                return RuntimeEnvironment.builder().shellType(ShellType.BASH).build();
            }

            @Override
            public String workDir() {
                return ".";
            }

            @Override
            public Path resolve(String path) {
                return Path.of(path);
            }
        };
        return ToolExecution.builder()
                .id("call-1")
                .toolDefinition(definition)
                .executionId("1")
                .turnId("1")
                .workspace(workspace)
                .args(toJson(request))
                .build();
    }

    private String toJson(ExecuteCommandRequest request) {
        try {
            return new ObjectMapper().writeValueAsString(Map.of(
                    "command", request.getCommand(),
                    "intention", request.getIntention() == null ? "" : request.getIntention()));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}

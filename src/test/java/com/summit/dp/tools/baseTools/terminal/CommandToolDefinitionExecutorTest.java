package com.summit.dp.tools.baseTools.terminal;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 终端执行器的所有返回路径都必须把模型声明的 {@code intention} 放进 toolMetaData
 * （随 ToolCallEndEvent.metaData 广播）；模型未填时省略键，绝不放 null 值。
 */
class CommandToolDefinitionExecutorTest {

    private final CommandToolDefinitionExecutor executor =
            new CommandToolDefinitionExecutor(new ObjectMapper());

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

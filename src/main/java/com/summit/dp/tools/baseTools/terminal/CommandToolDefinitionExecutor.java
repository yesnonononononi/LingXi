package com.summit.dp.tools.baseTools.terminal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.*;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.io.IOException;
import java.util.Map;

/** The executor of the command tool: parses arguments, refuses destructive commands and runs the rest. */
@Slf4j
@Getter
@RequiredArgsConstructor
public class CommandToolDefinitionExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;


    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            // resolve args
            ExecuteCommandRequest request = resolveArgs(toolExecution);

            if (request.getCommand() == null || request.getCommand().isBlank())
                return ToolExecuteResult.err("instruction is empty", ToolResultType.NORMAL, metaDataOf(request));

            Workspace workspace = toolExecution.getWorkspace();
            ShellType shellType = workspace == null ? null : workspace.runtimeEnvironment().shellType();
            if (CommandGuard.assess(request.getCommand(), shellType) == CommandGuard.Verdict.DESTRUCTIVE) {

                log.warn("【ToolCall】 refused destructive command: {}", request.getCommand());

                return ToolExecuteResult.err("command refused: it is destructive (disk/volume level, "
                        + "system-wide deletion or an irreversible halt) and cannot be approved — "
                        + "rephrase it or ask the user to run it themselves", ToolResultType.NORMAL, metaDataOf(request));
            }

            // execute
            return process(request, toolExecution.getWorkspace(), toolExecution.getToolDefinition());

        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e);
        }
    }

    /** execute tools */
    public ToolExecuteResult process(ExecuteCommandRequest request, Workspace workspace, ToolDefinition<?> toolDefinition) throws IOException, InterruptedException {

        ShellType shellType = workspace.runtimeEnvironment().shellType();

        if (shellType == null) throw new IllegalStateException("Unknown operating system");

        // The shell wrapper depends on the target environment; the bridge decides
        // where the command actually runs (host process vs. sandbox).
        WorkspaceBridge.CommandResult result = workspace.bridge().execute(
                shellType.buildCommand(request.getCommand()),
                workspace.workDir(),
                workspace.runtimeEnvironment().charset(),
                toolDefinition.timeout(),
                toolDefinition.maxOutput()
        );

        if (result.timedOut()) {
            return ToolExecuteResult.err("process timeout", ToolResultType.NORMAL, metaDataOf(request));
        }

        String processResult = result.truncated()
                ? result.output()
                : result.output() + "Exiting code :" + result.exitCode();
        if (result.truncated()) {
            processResult += String.format("""
                    [OUTPUT_TRUNCATED] 命令输出超过 %s token 的系统预算，已自动截断。
                    请改用更精确的命令；
                    """, toolDefinition.maxOutput()
            );
        }
        return result.exitCode() == 0
                ? ToolExecuteResult.success(processResult, ToolResultType.NORMAL, metaDataOf(request))
                : ToolExecuteResult.err(processResult, ToolResultType.NORMAL, metaDataOf(request));
    }

    /**
     * 工具自声明元数据：意图随返回值进 {@code ToolCallEndEvent.metaData}（与命令级 eventMetaData 合并），
     * 供监听器与前端结构化读取；模型未填时省略键，不放 null 值。
     */
    private Map<String, Object> metaDataOf(ExecuteCommandRequest request) {
        if (request == null || request.getIntention() == null || request.getIntention().isBlank()) {
            return Map.of();
        }
        return Map.of(ExecuteCommandRequest.INTENTION, request.getIntention());
    }

    /** resolve the tool args of agent str -> toolExecution */
    private ExecuteCommandRequest resolveArgs(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        return objectMapper.readValue(args, ExecuteCommandRequest.class);
    }

}

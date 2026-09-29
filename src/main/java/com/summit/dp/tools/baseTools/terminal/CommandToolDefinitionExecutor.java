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
                return ToolExecuteResult.err("instruction is empty");

            // Kernel safety floor — a deliberate SECOND interception that must NOT be removed.
            // The approval policy (CommandPolicyConfig) already calls CommandGuard.assess, but a policy
            // can be reconfigured (FULL_ACCESS) or bypassed on other execution paths; re-asserting the
            // SAME CommandGuard.assess verdict here guarantees a destructive command is refused at the
            // kernel and never offered for approval — approving it once would be unrecoverable.
            // Both sites share one judgment entry (CommandGuard.assess) so they can never disagree.
            Workspace workspace = toolExecution.getWorkspace();
            ShellType shellType = workspace == null ? null : workspace.runtimeEnvironment().shellType();
            if (CommandGuard.assess(request.getCommand(), shellType) == CommandGuard.Verdict.DESTRUCTIVE) {
                log.warn("【ToolCall】 refused destructive command: {}", request.getCommand());
                return ToolExecuteResult.err("command refused: it is destructive (disk/volume level, "
                        + "system-wide deletion or an irreversible halt) and cannot be approved — "
                        + "rephrase it or ask the user to run it themselves");
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
            return ToolExecuteResult.err("process timeout");
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
        return result.exitCode() == 0 ? ToolExecuteResult.success(processResult) : ToolExecuteResult.err(processResult);
    }

    /** resolve the tool args of agent str -> toolExecution */
    private ExecuteCommandRequest resolveArgs(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        return objectMapper.readValue(args, ExecuteCommandRequest.class);
    }

}

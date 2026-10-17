package com.summit.dp.workflow.infrastructure.tools.terminal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.tool.*;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Slf4j
@Getter
@RequiredArgsConstructor
public class CommandToolDefinitionExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final TerminalSecurityPolicy security;
    public CommandToolDefinitionExecutor(ObjectMapper mapper) { this(mapper, null); }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            // resolve args
            ExecuteCommandRequest request = resolveArgs(toolExecution);

            if (request.getCommand() == null || request.getCommand().isBlank())
                return ToolExecuteResult.err("instruction is empty", ToolResultType.NORMAL, buildMetadata(request));

            Workspace workspace = toolExecution.getWorkspace();
            ShellType shellType = workspace == null ? null : workspace.runtimeEnvironment().shellType();
            if (CommandGuard.assess(request.getCommand(), shellType) == CommandGuard.Verdict.DESTRUCTIVE) {

                log.warn("【ToolCall】 refused destructive command: {}", request.getCommand());

                return ToolExecuteResult.err("command refused: it is destructive (disk/volume level, "
                        + "system-wide deletion or an irreversible halt) and cannot be approved — "
                        + "rephrase it or ask the user to run it themselves", ToolResultType.NORMAL, buildMetadata(request));
            }

            // 审批后再次执行也走这里，最新禁止规则不能被旧审批绕过。
            SecurityDecision decision = security == null ? null : security.evaluate(request.getCommand());
            if (decision != null && decision.action() == SecurityAction.DENY) {
                return ToolExecuteResult.err("命令被安全规则禁止：" + decision.matchedRule());
            }
            // execute
            return process(request, toolExecution.getWorkspace(), toolExecution.getToolDefinition());

        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e);
        }
    }

    public ToolExecuteResult process(ExecuteCommandRequest request, Workspace workspace, ToolDefinition<?> toolDefinition) throws IOException, InterruptedException {

        // 原始命令交给框架，shell 的选择和启动由工作空间负责。
        WorkspaceCommands.CommandResult result = workspace.bridge().commands().execute(
                request.getCommand(),
                workspace.workDir(),
                workspace.runtimeEnvironment().charset(),
                toolDefinition.timeout(),
                TimeUnit.SECONDS,
                toolDefinition.maxOutput()
        );

        if (result.timedOut()) {
            return ToolExecuteResult.err("process timeout", ToolResultType.NORMAL, buildMetadata(request));
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
                ? ToolExecuteResult.success(processResult, ToolResultType.NORMAL, buildMetadata(request))
                : ToolExecuteResult.err(processResult, ToolResultType.NORMAL, buildMetadata(request));
    }

    /**
     * 工具自声明元数据：意图随返回值进 {@code ToolCallEndEvent.metaData}（与命令级 eventMetaData 合并），
     * 供监听器与前端结构化读取；模型未填时省略键，不放 null 值。
     */
    private Map<String, Object> buildMetadata(ExecuteCommandRequest request) {
        if (request == null || request.getIntention() == null || request.getIntention().isBlank()) {
            return Map.of();
        }
        return Map.of(ExecuteCommandRequest.INTENTION, request.getIntention());
    }

    private ExecuteCommandRequest resolveArgs(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        return objectMapper.readValue(args, ExecuteCommandRequest.class);
    }

}

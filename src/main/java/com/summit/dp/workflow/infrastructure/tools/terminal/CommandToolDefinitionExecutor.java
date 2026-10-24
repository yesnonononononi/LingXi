package com.summit.dp.workflow.infrastructure.tools.terminal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.tool.*;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcesser;
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
    private final BackendProcesser background;
    private final CommandToolProperties properties;
    public CommandToolDefinitionExecutor(ObjectMapper mapper, TerminalSecurityPolicy security, BackendProcesser background) {
        this(mapper, security, background, new CommandToolProperties());
    }
    public CommandToolDefinitionExecutor(ObjectMapper mapper) { this(mapper, null, null); }
    public CommandToolDefinitionExecutor(ObjectMapper mapper, TerminalSecurityPolicy security) { this(mapper, security, null); }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        ExecuteCommandRequest request = null;
        try {
            // resolve args
            request = resolveArgs(toolExecution);

            if (request.getCommand() == null || request.getCommand().isBlank())
                return ToolExecuteResult.err("instruction is empty", ToolResultType.NORMAL, buildMetadata(request));

            Workspace workspace = toolExecution.getWorkspace();
            ShellType shellType;
            try {
                // 本次调用实际使用的解释器只解析一次，检查、审批、执行都用它。
                shellType = CommandShell.resolve(request, workspace);
            } catch (IllegalArgumentException unsupported) {
                return ToolExecuteResult.err(unsupported.getMessage(), ToolResultType.NORMAL, buildMetadata(request));
            }
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
            if (request.isBackground()) {
                throwIf(background == null, "后台命令服务尚未装配");
                Long sessionId = ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.SESSION_ID);
                Long turnId = ExecutionEventMetadata.turnId(toolExecution.getEventMetaData());
                throwIf(turnId == null, "后台任务缺少所属轮次");
                Long executionId = ExecutionIdentity.numericOrNull(toolExecution.getExecutionId());
                throwIf(executionId == null || executionId <= 0, "后台任务缺少有效执行标识");
                Long taskId = background.submit(request.getCommand(), request.getIntention(), sessionId, turnId,
                        executionId, shellType, workspace, properties.getBackgroundTimeout().toSeconds(), toolExecution.getToolDefinition().maxOutput());
                return ToolExecuteResult.success(objectMapper.writeValueAsString(Map.of("taskId", taskId.toString(),
                        "message", "后台任务已登记，完成后会通知当前执行；可使用 manage_command 查询或停止")), ToolResultType.NORMAL, buildMetadata(request));
            }
            return process(request, shellType, toolExecution.getWorkspace(), toolExecution.getToolDefinition());

        } catch (InterruptedException e) {
            // 打断来自框架的停止执行（或工具超时后的 future.cancel）：进程已由 ProcessCoordinator
            // 强杀回收。这里必须保留打断标记并给出「已中断」的明确回执，不能伪装成普通执行失败，
            // 否则上层会把「用户主动停的命令」当成模型该重试的故障。
            Thread.currentThread().interrupt();
            return ToolExecuteResult.err("command interrupted before it completed",
                    ToolResultType.NORMAL, buildMetadata(request));
        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e);
        }
    }

    public ToolExecuteResult process(ExecuteCommandRequest request, ShellType shell, Workspace workspace, ToolDefinition<?> toolDefinition) throws IOException, InterruptedException {

        // 原始命令连同本次解析出的 shell 交给框架，shell 的启动参数由 ShellType 构造。
        WorkspaceCommands.CommandResult result = workspace.bridge().commands().execute(
                request.getCommand(),
                shell,
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

    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }

}

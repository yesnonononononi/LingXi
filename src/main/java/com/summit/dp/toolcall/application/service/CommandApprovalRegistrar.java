package com.summit.dp.toolcall.application.service;

import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** 命令先登记准备槽位；开放审批必须晚于旧信号释放。 */
@Service
@RequiredArgsConstructor
public class CommandApprovalRegistrar {

    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;

    /**
     * 把待审批命令登记为一条 {@code PROMISE} 卡片（唯一权威源），并推送统一卡片事件。
     *
     * @param execution 本次命令执行的框架上下文（提供 tool_call/execution 标识与工作空间）
     * @param command   待审批的原始命令文本
     * @param shell     命令将要运行的目标 shell（写入卡片载荷，供前端展示）
     */
    public void register(ToolExecution execution, String command, ShellType shell) {
        long sessionId = ExecutionIdentity.sessionId(execution);
        long executionId = Long.parseLong(execution.getExecutionId());
        String toolCallId = execution.getId();
        String toolName = execution.getToolDefinition().name();
        String workspaceId = execution.getWorkspace().id();
        String workDir = execution.getWorkspace().workDir();

        registrar.registerPromise(ToolCallRegisterCommand.promise(
                toolCallId, sessionId, executionId, toolName, ToolCallKind.COMMAND, "命令审批",
                converter.commandContent(command, workDir, shell.name(), workspaceId, execution.getArgs()),
                converter.rawInput(execution.getArgs())));
    }
}

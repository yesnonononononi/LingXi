package com.summit.dp.workflow.application.decision;

import com.summit.core.tool.ToolExecution;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** 文件改动审批：把待批准的越界写入登记为一条 {@code PROMISE} 卡片。 */
@Service
@RequiredArgsConstructor
public class FileWriteApprovalRegistrar {

    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;

    /**
     * 登记待审批的文件改动（唯一权威源），并推送统一卡片事件。
     *
     * @param execution 本次写入的框架上下文（提供 tool_call/execution 标识与工作空间）
     * @param path      模型下发的原始路径，未做解析
     */
    public void register(ToolExecution execution, String path) {
        long sessionId = ExecutionIdentity.sessionId(execution);
        long executionId = Long.parseLong(execution.getExecutionId());
        registrar.registerPromise(ToolCallRegisterCommand.promise(
                execution.getId(), sessionId, executionId, execution.getToolDefinition().name(),
                ToolCallKind.FILE_WRITE, "文件改动审批",
                converter.fileWriteContent(path, execution.getWorkspace().workDir(),
                        execution.getWorkspace().id(), execution.getArgs()),
                converter.rawInput(execution.getArgs())));
    }
}

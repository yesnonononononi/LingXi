package com.summit.dp.tools.baseTools.plan;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.tools.baseTools.arguments.PlanCreateArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/** 只登记准备中的计划，旧执行退出后才开放审批。 */
@Slf4j
@RequiredArgsConstructor
@Component
public class CreatePlanTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ToolCallRegistrar registrar;
    private final ToolCallConverter converter;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        String args = toolExecution.getArgs();
        try {
            PlanCreateArgument argument = objectMapper.readValue(args, PlanCreateArgument.class);
            long executionId = Long.parseLong(toolExecution.getExecutionId());
            long sessionId = ExecutionIdentity.sessionId(toolExecution);
            String toolCallId = toolExecution.getId();

            registrar.registerPromise(ToolCallRegisterCommand.promise(
                    toolCallId, sessionId, executionId, ToolCatalog.CREATE_PLAN, ToolCallKind.PLAN,
                    argument.getTitle(),
                    converter.planContent(argument.getTitle(), argument.getText()),
                    converter.rawInput(args)));
            // 工具结果保持中性：模型已看到自己提交的计划书，用户回复随后以 User Reply 系统消息进入上下文。
            return ToolExecuteResult.promise("Waiting for the user.");
        } catch (JsonProcessingException e) {
            log.error("Error processing JSON", e);
            throw new RuntimeException(e);
        }
    }
}

package com.summit.dp.workflow.infrastructure.tools.plan;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.tools.arguments.PlanCreateArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/** 只登记准备中的计划，旧执行退出后才开放审批。 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.CREATE_PLAN,
    name = ToolCatalog.CREATE_PLAN,
    executor = CreatePlanTool.class,
    description = """
        Create a plan for the given task.
        The user may have embedded some tips in your plan so it is common if you see other text that differs from the original plan text.
        However, you don't ignore them.
        """,
    parametersJsonSchema = """
        {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "The title of the plan to create."},
            "text" : {"type": "string", "description": "The text of the plan to create. it is displayed by the format of MARKDOWN"}
        },
        "required": ["title"],
        "additionalProperties": false
        }
        """,
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 5_000,
    timeout = 6_000L)
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
            log.error("解析计划内容失败: reason=JSON解析异常", e);
            throw new RuntimeException(e);
        }
    }
}

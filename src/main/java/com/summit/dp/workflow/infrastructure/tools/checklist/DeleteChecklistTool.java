package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.DeleteChecklistArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 软删清单。
 *
 * <p>删除后不物理清除：未完成的步骤是「这件事到底做到哪」的证据，删掉就没有了。
 * 重复删除返回既有删除事实，不会因为重试而变成错误。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.DELETE_CHECKLIST,
    name = ToolCatalog.DELETE_CHECKLIST,
    executor = DeleteChecklistTool.class,
    description = """
        软删清单并释放本会话的活动清单名额，保留全部步骤历史。
        仅在剩余工作确实全部完成时传 completeOpenSteps=true，将未结束步骤与删除操作在同一事务完成，
        可用于完成“删除整个清单”这一步；已有 FAILED、SKIPPED 等终态结果保持不变。
        放弃或替换任务时省略此参数或传 false，保留未完成事实，不能虚报完成。
        重复删除返回既有删除快照，不能补改历史步骤；本工具不创建或取消 create_plan 审批卡片。
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "checklistId", value = @Value(
                type = ValueType.INTEGER,
                description = "上次权威快照中的清单标识。")),
            @ToolProperty(key = "completeOpenSteps", value = @Value(
                type = ValueType.BOOLEAN,
                description = "显式确认剩余工作全部完成，删除时一并完成未结束步骤；默认 false。"))
        },
        required = {"checklistId"},
        additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.ISOLATED_MUTATION,
    maxOutput = 2_000,
    timeout = 5_000L)
public class DeleteChecklistTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            DeleteChecklistArgument argument = ChecklistToolSupport.parse(objectMapper,
                    toolExecution.getArgs(), DeleteChecklistArgument.class);
            ChecklistVO snapshot = checklistService.delete(ChecklistCommand.delete(
                    ChecklistToolSupport.sessionId(toolExecution), argument.getChecklistId(), argument.isCompleteOpenSteps()));
            return ToolExecuteResult.success(ChecklistToolSupport.render(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("删除清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

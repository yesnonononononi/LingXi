package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.anno.type.StringValue;
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
import com.summit.dp.workflow.infrastructure.tools.arguments.UpdateChecklistStepArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/** 开始与结果均由模型明确上报，界面不猜测正在处理哪一步。 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.UPDATE_CHECKLIST_STEP,
    name = ToolCatalog.UPDATE_CHECKLIST_STEP,
    executor = UpdateChecklistStepTool.class,
    description = """
        Before working on a checklist step, mark it IN_PROGRESS; then report COMPLETED, FAILED or SKIPPED.
        Report the real outcome: never mark unfinished work as COMPLETED just to empty the checklist;
        use FAILED or SKIPPED with an honest step content instead.
        PENDING may become IN_PROGRESS or a terminal status; finished steps cannot be reopened.
        IN_PROGRESS does not count as completed progress or renew the reminder budget.
        Marking a step that is already in the requested status is a no-op and returns the snapshot.
        This tool maintains the execution checklist only; it never creates an approval card (create_plan does that).
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "checklistId", value = @Value(
                type = ValueType.INTEGER,
                description = "Checklist id from a previous snapshot; omit to use this session's ACTIVE checklist.")),
            @ToolProperty(key = "stepId", value = @Value(
                type = ValueType.INTEGER,
                description = "Stable step id from the snapshot; seq is only display order and cannot be used instead.")),
            @ToolProperty(key = "status", value = @Value(
                type = ValueType.STRING,
                stringValue = @StringValue(enums = {"IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"}),
                description = "Explicit start or real outcome of the step."))
        },
        required = {"stepId", "status"},
        additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.ISOLATED_MUTATION,
    maxOutput = 4_000,
    timeout = 5_000L)
public class UpdateChecklistStepTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            UpdateChecklistStepArgument argument = ChecklistToolSupport.parse(objectMapper,
                    toolExecution.getArgs(), UpdateChecklistStepArgument.class);
            ChecklistVO snapshot = checklistService.updateStep(ChecklistCommand.updateStep(
                    ChecklistToolSupport.sessionId(toolExecution),
                    argument.getChecklistId(),
                    argument.getStepId(),
                    argument.getStatus()));
            return ToolExecuteResult.success(ChecklistToolSupport.render(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("更新清单步骤被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

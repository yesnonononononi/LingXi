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
        Soft-delete a checklist when the task was abandoned or replaced by a different plan.
        The history is kept: deleting releases the session's single ACTIVE slot but never erases the steps,
        so unfinished work stays visible instead of being faked as done.
        Deleting an already deleted checklist returns the existing deletion instead of failing.
        This is not create_plan related: no approval card is produced or cancelled here.
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "checklistId", value = @Value(
                type = ValueType.INTEGER,
                description = "Checklist id from a previous snapshot."))
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
                    ChecklistToolSupport.sessionId(toolExecution), argument.getChecklistId()));
            return ToolExecuteResult.success(ChecklistToolSupport.render(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("删除清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

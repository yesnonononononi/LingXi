package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ModifyChecklistArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 修改清单结构：改标题、改步骤文案、增删与重排步骤。
 *
 * <p>参数是<b>显式补丁</b>（嵌套数组），所以用 {@code parametersJsonSchema} 而不是注解根对象：
 * 注解只表达标量与标量数组，嵌套对象必须写 schema。
 * 补丁语义：没出现的步骤不会消失；已有步骤 ID 不变；新增步骤一律待处理。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.MODIFY_CHECKLIST,
    name = ToolCatalog.MODIFY_CHECKLIST,
    executor = ModifyChecklistTool.class,
    description = """
        修改任意未删除执行清单的标题、步骤文案、结构和顺序；已收口清单需显式传入 checklistId。
        删除步骤必须显式提供 removeStepIds；未提供的步骤保留，已有 stepId 和状态不随改文案变化。
        新增步骤从 PENDING 开始；不能删光步骤，orderedStepIds 必须恰好覆盖修改后的全部步骤。
        实际变更后仍有未结束步骤时重新激活；会话内不能同时存在另一份活动清单，空补丁不会重新激活。
        汇总状态按步骤派生：全部成功为 COMPLETED，含失败为 FAILED，无失败但有跳过为 CLOSED。
        本工具不产生审批卡片；需要用户批准计划时使用 create_plan。
        只返回清单标识与状态统计，需要修改后的步骤标识、顺序或完整内容时调用 get_current_checklist。
        """,
    parametersJsonSchema = """
        {
          "type": "object",
          "properties": {
            "checklistId": {
              "type": "integer",
              "description": "权威清单标识；已收口清单必须提供，省略时仅定位活动清单。"
            },
            "newTitle": {
              "type": "string",
              "maxLength": 200,
              "description": "New checklist title. Omit to keep the current title."
            },
            "stepContents": {
              "type": "array",
              "description": "Reword existing steps. Status is preserved, so finished steps stay finished.",
              "items": {
                "type": "object",
                "properties": {
                  "stepId": { "type": "integer", "description": "Stable step id from the snapshot." },
                  "content": { "type": "string", "maxLength": 500, "description": "New step content." }
                },
                "required": ["stepId", "content"],
                "additionalProperties": false
              }
            },
            "addSteps": {
              "type": "array",
              "maxItems": 50,
              "description": "New step contents appended in order; they always start as PENDING.",
              "items": { "type": "string", "minLength": 1, "maxLength": 500 }
            },
            "removeStepIds": {
              "type": "array",
              "description": "Step ids to delete. All steps cannot be removed at once.",
              "items": { "type": "integer" }
            },
            "orderedStepIds": {
              "type": "array",
              "description": "Complete step order after the patch. Omit to keep the current order.",
              "items": { "type": "integer" }
            }
          },
          "required": ["checklistId"],
          "additionalProperties": false
        }
        """,
    concurrentPolicy = ConcurrentPolicy.ISOLATED_MUTATION,
    maxOutput = 4_000,
    timeout = 5_000L)
public class ModifyChecklistTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            ModifyChecklistArgument argument = ChecklistToolSupport.parse(objectMapper,
                    toolExecution.getArgs(), ModifyChecklistArgument.class);
            ChecklistVO snapshot = checklistService.modify(ChecklistCommand.modify(
                    ChecklistToolSupport.sessionId(toolExecution),
                    argument.getChecklistId(),
                    argument.getNewTitle(),
                    contentPatches(argument),
                    argument.getAddSteps(),
                    argument.getRemoveStepIds(),
                    argument.getOrderedStepIds()));
            return ToolExecuteResult.success(ChecklistToolSupport.renderReceipt(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("修改清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }

    /** 把工具的嵌套参数翻译成应用层补丁项，隔离两边字段名。 */
    private List<ChecklistCommand.StepContent> contentPatches(ModifyChecklistArgument argument) {
        if (argument.getStepContents() == null || argument.getStepContents().isEmpty()) {
            return List.of();
        }
        return argument.getStepContents().stream()
                .filter(patch -> patch != null)
                .map(patch -> new ChecklistCommand.StepContent(patch.getStepId(), patch.getContent()))
                .toList();
    }
}

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
import com.summit.dp.checklist.domain.model.ChecklistRules;
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
        处理步骤前标记 IN_PROGRESS，结束后如实上报 COMPLETED、FAILED 或 SKIPPED，不能为清空清单虚报完成。
        同一阶段确认多项结果时，立即用 updates 批量上报，可同时显式标记下一步为 IN_PROGRESS。
        批量中的步骤必须属于同一清单且不能重复，任一项不合法则整批拒绝。批量回执只返回清单状态与统计。
        可以退回 PENDING 或 IN_PROGRESS，也可以修正终态结果，原 stepId 保持不变。
        已收口清单需显式传入 checklistId；状态变更后仍有未结束步骤时重新激活，会话内不能另有活动清单。
        DELETED 清单不可修改；同状态重试只返回既有状态的回执，不刷新时间或提醒额度。
        PENDING 和 IN_PROGRESS 不算实际完成进展，不刷新提醒额度。
        有未结束步骤时汇总为 ACTIVE；全部成功才是 COMPLETED，结案后含失败为 FAILED，否则含跳过为 CLOSED。
        上报终态结果时可传 continueNextStep=true，在同一事务中将当前顺序之后的第一个未结束步骤标为 IN_PROGRESS，
        自动跳过终态步骤；没有后续步骤时只更新当前结果。默认 false；回退状态时不能启用。
        同状态重试不会启动其他步骤；只返回状态统计、本步骤及后续步骤的标识与状态，不回传完整正文。
        需要完整清单或步骤内容时调用 get_current_checklist。
        本工具只维护执行清单；create_plan 才会创建审批卡片。
        """,
    parametersJsonSchema = """
        {
          "type": "object",
          "properties": {
            "checklistId": {
              "type": "integer",
              "description": "权威清单标识；省略时定位本会话的活动清单，更新已收口清单时必须提供。"
            },
            "stepId": {
              "type": "integer",
              "description": "单步更新的稳定步骤标识，来自权威快照，不能用展示序号代替。"
            },
            "status": {
              "type": "string",
              "enum": ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"],
              "description": "单步更新的真实步骤状态。"
            },
            "continueNextStep": {
              "type": "boolean",
              "description": "仅单步上报终态时可设为 true，启动之后的第一个未结束步骤。"
            },
            "updates": {
              "type": "array",
              "description": "批量更新时逐项给出步骤标识和目标状态，省略顶层 stepId、status 和 continueNextStep。",
              "minItems": 1,
              "maxItems": """ + ChecklistRules.MAX_STEPS + ",\n" + """
              "items": {
                "type": "object",
                "properties": {
                  "stepId": { "type": "integer", "description": "权威快照中的稳定步骤标识。" },
                  "status": {
                    "type": "string",
                    "enum": ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"]
                  }
                },
                "required": ["stepId", "status"],
                "additionalProperties": false
              }
            }
          },
          "oneOf": [
            { "required": ["stepId", "status"] },
            { "required": ["updates"] }
          ],
          "additionalProperties": false
        }
        """,
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
            ChecklistVO snapshot = checklistService.updateStep(ChecklistCommand.builder()
                    .sessionId(ChecklistToolSupport.sessionId(toolExecution))
                    .checklistId(argument.getChecklistId())
                    .stepId(argument.getStepId())
                    .status(argument.getStatus())
                    .continueNextStep(argument.isContinueNextStep())
                    .updates(argument.getUpdates())
                    .build());
            return ToolExecuteResult.success(ChecklistToolSupport.renderReceipt(objectMapper, snapshot,
                    argument.getStepId(), argument.isContinueNextStep()));
        } catch (ClientException e) {
            log.info("更新清单步骤被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

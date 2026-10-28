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
        处理步骤前标记 IN_PROGRESS，结束后如实上报 COMPLETED、FAILED 或 SKIPPED，不能为清空清单虚报完成。
        可以退回 PENDING 或 IN_PROGRESS，也可以修正终态结果，原 stepId 保持不变。
        已收口清单需显式传入 checklistId；状态变更后仍有未结束步骤时重新激活，会话内不能另有活动清单。
        DELETED 清单不可修改；同状态重试只返回既有状态的回执，不刷新时间或提醒额度。
        PENDING 和 IN_PROGRESS 不算实际完成进展，不刷新提醒额度。
        上报终态结果时可传 continueNextStep=true，在同一事务中将当前顺序之后的第一个未结束步骤标为 IN_PROGRESS，
        自动跳过终态步骤；没有后续步骤时只更新当前结果。默认 false；回退状态时不能启用。
        同状态重试不会启动其他步骤；只返回状态统计、本步骤及后续步骤的标识与状态，不回传完整正文。
        需要完整清单或步骤内容时调用 get_current_checklist。
        本工具只维护执行清单；create_plan 才会创建审批卡片。
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "checklistId", value = @Value(
                type = ValueType.INTEGER,
                description = "权威快照中的清单标识；省略时定位本会话的活动清单，修正已收口清单时必须提供。")),
            @ToolProperty(key = "stepId", value = @Value(
                type = ValueType.INTEGER,
                description = "权威快照中的稳定步骤标识，不能用展示顺序 seq 代替。")),
            @ToolProperty(key = "status", value = @Value(
                type = ValueType.STRING,
                stringValue = @StringValue(enums = {"PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"}),
                description = "明确开始、回退或修正后的真实步骤状态。")),
            @ToolProperty(key = "continueNextStep", value = @Value(
                type = ValueType.BOOLEAN,
                description = "上报终态结果后，是否按当前顺序启动后面的第一个未结束步骤；默认 false，同状态重试不继续推进。"))
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
                    argument.getStatus(),
                    argument.isContinueNextStep()));
            return ToolExecuteResult.success(ChecklistToolSupport.renderReceipt(objectMapper, snapshot,
                    argument.getStepId(), argument.isContinueNextStep()));
        } catch (ClientException e) {
            log.info("更新清单步骤被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

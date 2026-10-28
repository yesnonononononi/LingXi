package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ArrayValue;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.anno.type.ScalarType;
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
import com.summit.dp.checklist.domain.model.ChecklistRules;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.CreateChecklistArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 创建执行清单：一次给出标题与全部步骤。
 *
 * <p>与 {@code create_plan} 的边界写进了工具描述里：本工具不产生审批卡片、不阻塞执行，
 * 只登记「这次要做哪几步」；必须等用户批准计划时仍然用 {@code create_plan}。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.CREATE_CHECKLIST,
    name = ToolCatalog.CREATE_CHECKLIST,
    executor = CreateChecklistTool.class,
    description = """
        为多步任务创建执行清单，工作过程中持续更新；单步任务不需要清单。
        本工具只记录执行步骤、不阻塞执行；需要用户批准计划时使用 create_plan 审批卡片。
        创建后只返回清单标识与状态统计，需要稳定 stepId 和完整内容时调用 get_current_checklist。
        同一会话最多持有一份 ACTIVE 清单。
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "title", value = @Value(
                type = ValueType.STRING,
                description = "Short goal of the checklist, e.g. the task being executed.")),
            @ToolProperty(key = "steps", value = @Value(
                type = ValueType.ARRAY,
                arrayValue = @ArrayValue(itemType = ScalarType.STRING,
                    minItems = ChecklistRules.MIN_STEPS, maxItems = ChecklistRules.MAX_STEPS),
                description = "Step contents in execution order; each step must be a concrete action."))
        },
        required = {"title", "steps"},
        additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.ISOLATED_MUTATION,
    maxOutput = 4_000,
    timeout = 5_000L)
public class CreateChecklistTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            CreateChecklistArgument argument = ChecklistToolSupport.parse(objectMapper,
                    toolExecution.getArgs(), CreateChecklistArgument.class);
            ChecklistVO snapshot = checklistService.create(ChecklistCommand.create(
                    ChecklistToolSupport.sessionId(toolExecution),
                    ChecklistToolSupport.agentId(toolExecution),
                    argument.getTitle(),
                    argument.getSteps()));
            return ToolExecuteResult.success(ChecklistToolSupport.renderReceipt(objectMapper, snapshot));
        } catch (ClientException e) {
            // 业务拒绝（已有活动清单、空步骤、超长标题）一律回可读文案，模型据此自行纠正
            log.info("创建清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

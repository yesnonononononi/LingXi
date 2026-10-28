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
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.GetChecklistArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 按标识审计一份清单的全部历史。
 *
 * <p>存在的理由只有一个：删除是软删，历史必须能被重新读到，否则「保留现场」只是数据库里的一句自我安慰。
 * 它不改变任何状态，也不参与「还剩什么没做」的判定。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
    id = ToolCatalog.GET_CHECKLIST,
    name = ToolCatalog.GET_CHECKLIST,
    executor = GetChecklistTool.class,
    description = """
        按 checklistId 读取任意状态的清单快照（ACTIVE/COMPLETED/CLOSED/FAILED/UNFINISHED/DELETED 都可读），
        用于复核已收口或已删除的历史；返回完整步骤正文、状态与进度版本。
        只读，不改步骤、不推进版本、不产生 create_plan 审批卡片；需要继续干活时用 get_current_checklist。
        归属取执行上下文，跨会话一律拒绝；清单不存在时 success 且 checklist 为 null。
        本工具只读执行清单历史；create_plan 才会创建审批卡片。
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "checklistId", value = @Value(
                type = ValueType.INTEGER,
                description = "权威快照中的清单标识；通常来自 get_current_checklist 或本地已有的回执。"))
        },
        required = {"checklistId"},
        additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 64_000,
    timeout = 5_000L)
public class GetChecklistTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            GetChecklistArgument argument = ChecklistToolSupport.parse(objectMapper,
                    toolExecution.getArgs(), GetChecklistArgument.class);
            ChecklistVO snapshot = checklistService.findById(
                    ChecklistToolSupport.sessionId(toolExecution), argument.getChecklistId()).orElse(null);
            return ToolExecuteResult.success(ChecklistToolSupport.renderSnapshot(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("按标识查询清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

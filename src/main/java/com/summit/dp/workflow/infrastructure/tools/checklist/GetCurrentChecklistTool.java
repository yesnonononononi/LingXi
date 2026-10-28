package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/** 会话只取执行上下文，模型不能借查询工具读取其他会话的清单。 */
@Slf4j
@Component
@RequiredArgsConstructor
@Tool(
    id = ToolCatalog.GET_CURRENT_CHECKLIST,
    name = ToolCatalog.GET_CURRENT_CHECKLIST,
    executor = GetCurrentChecklistTool.class,
    description = """
        查看当前会话的完整执行清单，返回稳定 stepId、顺序、步骤正文与最新状态。
        需要获取步骤标识、核对完整内容或恢复遗忘的清单时按需调用；写工具只返回精简回执。
        优先返回活动清单，否则查看最近一份清单；最近一份已删除或没有清单时 checklist 为 null。
        无需参数，会话归属取执行上下文；只读，不修改步骤，也不创建 create_plan 审批卡片。
        """,
    parameters = @ObjectValue(additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 64_000,
    timeout = 5_000L)
public class GetCurrentChecklistTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final ChecklistService checklistService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            ChecklistVO snapshot = checklistService.findCurrent(ChecklistToolSupport.sessionId(toolExecution)).orElse(null);
            return ToolExecuteResult.success(ChecklistToolSupport.renderSnapshot(objectMapper, snapshot));
        } catch (ClientException e) {
            log.info("查看当前清单被拒绝: reason={}", e.getMessage());
            return ToolExecuteResult.err(e.getMessage());
        }
    }
}

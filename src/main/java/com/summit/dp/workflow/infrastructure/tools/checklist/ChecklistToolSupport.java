package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 四个清单工具共用的参数解析与回执渲染。
 *
 * <p>放在工具包而不是应用层：这些是「给模型看的形状」，不是业务规则。
 * 业务规则一律在 {@code ChecklistService} 与领域对象里，Executor 只解析参数、委派、翻译错误。</p>
 */
final class ChecklistToolSupport {

    private ChecklistToolSupport() {
    }

    /** 解析模型下发的 JSON 参数；失败就是可读的中文错误，而不是栈。 */
    static <T> T parse(ObjectMapper objectMapper, String args, Class<T> type) {
        if (args == null || args.isBlank()) {
            throw new ClientException("工具参数不能为空");
        }
        try {
            T value = objectMapper.readValue(args, type);
            if (value == null) {
                throw new ClientException("工具参数不能为空");
            }
            return value;
        } catch (JsonProcessingException e) {
            throw new ClientException("工具参数不是合法 JSON：" + e.getOriginalMessage(), e);
        }
    }

    /** 会话归属只从执行上下文取，模型不能指定；子会话拿到的是自己的会话。 */
    static long sessionId(ToolExecution toolExecution) {
        return ExecutionIdentity.sessionId(toolExecution);
    }

    /** 记录用的 Agent 标识，缺失即为 {@code null}，不阻断调用。 */
    static Long agentId(ToolExecution toolExecution) {
        return ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.AGENT_ID);
    }

    /**
     * 渲染权威快照：模型必须看到稳定 stepId 与 seq，才能在下一次调用里指对步骤。
     *
     * <p>附一句状态提示：清单已收口时不要再去推进步骤，避免模型拿旧快照反复重试。</p>
     */
    static String render(ObjectMapper objectMapper, ChecklistVO snapshot) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("checklist", snapshot);
        payload.put("hint", hint(snapshot));
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new ClientException("清单快照序列化失败", e);
        }
    }

    private static String hint(ChecklistVO snapshot) {
        if (snapshot == null) {
            return "没有可用的清单快照。";
        }
        return switch (snapshot.getStatus()) {
            case "ACTIVE" -> "清单仍在执行中：完成一个步骤后立刻用 update_checklist_step 如实标记结果。";
            case "COMPLETED" -> "清单已收口：所有步骤都已是终态（含失败与跳过），不需要再推进。";
            case "UNFINISHED" -> "清单因无实际推进被关闭：需要继续工作请新建清单。";
            case "DELETED" -> "清单已删除：历史保留但不可再修改。";
            default -> "未知清单状态。";
        };
    }
}

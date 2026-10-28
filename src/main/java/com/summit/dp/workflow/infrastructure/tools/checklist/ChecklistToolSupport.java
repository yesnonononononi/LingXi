package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 清单工具共用的参数解析与回执渲染。
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

    /** 完整快照只在模型主动查询时返回，避免每次写入都复制全部步骤。 */
    static String renderSnapshot(ObjectMapper objectMapper, ChecklistVO snapshot) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("checklist", snapshot);
        payload.put("hint", hint(snapshot));
        return serialize(objectMapper, payload);
    }

    /** 写回执不含步骤正文，体积不随清单长度增长。 */
    static String renderReceipt(ObjectMapper objectMapper, ChecklistVO snapshot) {
        return renderReceipt(objectMapper, snapshot, null, false);
    }

    /** 继续下一步只携带一个后续步骤的权威标识和状态，重试时也不暗示它刚被启动。 */
    static String renderReceipt(ObjectMapper objectMapper, ChecklistVO snapshot, Long stepId, boolean includeNextStep) {
        List<ChecklistVO.StepVO> steps = snapshot.sortedSteps();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("checklistId", snapshot.getChecklistId());
        payload.put("status", snapshot.getStatus());
        payload.put("progressVersion", snapshot.getProgressVersion());
        payload.put("stepCount", steps.size());
        payload.put("openStepCount", steps.stream().filter(ChecklistToolSupport::isOpen).count());
        steps.stream().filter(step -> Objects.equals(step.getStepId(), stepId)).findFirst().ifPresent(step -> {
            payload.put("step", buildStepIdentity(step));
            if (includeNextStep) {
                steps.stream().filter(candidate -> candidate.getSeq() > step.getSeq())
                        .filter(ChecklistToolSupport::isOpen).findFirst()
                        .ifPresent(following -> payload.put("nextStep", buildStepIdentity(following)));
            }
        });
        payload.put("hint", "DELETED".equals(snapshot.getStatus()) ? hint(snapshot)
                : "需要步骤标识或完整清单时调用 get_current_checklist。");
        return serialize(objectMapper, payload);
    }

    private static boolean isOpen(ChecklistVO.StepVO step) {
        return "PENDING".equals(step.getStatus()) || "IN_PROGRESS".equals(step.getStatus());
    }

    private static Map<String, Object> buildStepIdentity(ChecklistVO.StepVO step) {
        return Map.of("stepId", step.getStepId(), "seq", step.getSeq(), "status", step.getStatus());
    }

    private static String serialize(ObjectMapper objectMapper, Map<String, Object> payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new ClientException("清单工具回执序列化失败", e);
        }
    }

    private static String hint(ChecklistVO snapshot) {
        if (snapshot == null) {
            return "当前会话没有可查看的清单，需要记录任务时可用 create_checklist 创建。";
        }
        return switch (snapshot.getStatus()) {
            case "ACTIVE" -> "开始处理步骤前用 update_checklist_step 标记 IN_PROGRESS，完成后立刻如实标记结果。";
            case "COMPLETED" -> "清单已收口：所有步骤都已是终态（含失败与跳过）；需要修正时可带 checklistId 更新或回退步骤。";
            case "UNFINISHED" -> "清单因无实际推进被关闭：可带 checklistId 修正步骤；重新激活前会话内不能有其他活动清单。";
            case "DELETED" -> "清单已删除：历史保留但不可再修改。";
            default -> "未知清单状态。";
        };
    }
}

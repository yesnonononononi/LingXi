package com.summit.dp.tools.baseTools.sub_agent.result;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 受理回执不代表子任务完成，主理人须按产物和验证记录验收。
 * 返回普通成功结果，避免协作式委派变成阻塞等待。
 *
 * <p>回执是模型消费的结构化 JSON，按项目约定用 record + Jackson 构建（禁手工 {@code Map.put} 拼装），
 * 使键名与类型在同一处声明、可被编译器校验。</p>
 */
@Component
@RequiredArgsConstructor
public class AsyncDelegationResultRenderer {

    /** 受理回执里的运行模式键值。前端 {@code frontend/src/utils/asyncDelegation.ts} 依赖该键识别委派，保留。 */
    private static final String RUNTIME_MODE_ASYNC = "ASYNC";

    private static final String NOTE = "委派已受理，子任务尚未完成。请继续独立工作，并核验工作目录中的产物和验证记录；"
            + "交付说明与邮件都不是验收依据，没有邮件也应自行验收，没有可用成果就重新委派。";

    private final ObjectMapper objectMapper;

    /**
     * 构建协作式结构化结果。
     *
     * @param subSessionId 目标子会话 id（字符串下发，避免雪花 id 精度丢失）
     * @param agentId      目标 Agent id（数值）
     * @param agentName    目标 Agent 名称
     */
    public ToolExecuteResult render(String subSessionId, Long agentId, String agentName) {
        AcceptanceReceipt receipt = new AcceptanceReceipt(
                RUNTIME_MODE_ASYNC, true, subSessionId, agentId, agentName, NOTE);
        try {
            return ToolExecuteResult.success(objectMapper.writeValueAsString(receipt));
        } catch (JsonProcessingException e) {
            return ToolExecuteResult.err("协作式委派结果序列化失败: " + e.getMessage());
        }
    }

    /** 受理回执载荷：字段声明即键名与顺序，写读同源。 */
    private record AcceptanceReceipt(String runtimeMode, boolean delegated, String subSessionId,
                                     Long agentId, String agentName, String note) {
    }
}

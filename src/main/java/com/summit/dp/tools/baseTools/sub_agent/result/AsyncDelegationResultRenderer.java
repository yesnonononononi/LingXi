package com.summit.dp.tools.baseTools.sub_agent.result;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 协作式委派的工具结果渲染：把「已受理」这件事渲染成结构化 JSON（英文键）。
 *
 * <p>只做「事实 → JSON」的翻译，不碰任何状态。刻意<b>不含</b>子代理正文 / 最终结果 ——
 * 协作式的结果由子代理事后用邮件送达；这里若带上正文，指挥者会以为子任务已完结而重复处理。</p>
 *
 * <p>必须返回普通成功结果，<b>不得</b>返回 PROMISE：后者会让父执行同步挂起等待一个永远不会回传的终态。</p>
 */
@Component
@RequiredArgsConstructor
public class AsyncDelegationResultRenderer {

    private static final String NOTE = "Delegation accepted. The teammate will deliver its result to you by email.";

    private final ObjectMapper objectMapper;

    /**
     * 构建协作式结构化结果。
     *
     * @param subSessionId 目标子会话 id（字符串下发，避免雪花 id 精度丢失）
     * @param agentId      目标 Agent id（数值）
     * @param agentName    目标 Agent 名称
     */
    public ToolExecuteResult render(String subSessionId, Long agentId, String agentName) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runtimeMode", "ASYNC");
        payload.put("delegated", true);
        payload.put("subSessionId", subSessionId);
        payload.put("agentId", agentId);
        payload.put("agentName", agentName);
        payload.put("note", NOTE);
        try {
            return ToolExecuteResult.success(objectMapper.writeValueAsString(payload));
        } catch (JsonProcessingException e) {
            return ToolExecuteResult.err("协作式委派结果序列化失败: " + e.getMessage());
        }
    }
}

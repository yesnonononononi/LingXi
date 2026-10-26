package com.summit.dp.workflow.infrastructure.tools.web;

import lombok.Builder;

/**
 * web_search 工具的运行时配置。
 *
 * @param baseUrl   检索服务地址
 * @param apiKey    检索服务密钥
 * @param timeout   HTTP 超时秒数
 * @param maxResult 单次检索允许返回的最大结果条数
 * @param maxOutput 工具允许输出的最大字符数，必须与 {@code ToolDefinition} 上的 {@code maxOutput}
 *                  同源（由装配层用同一个常量注入）；摘要触发阈值按该值的百分比计算。
 *                  {@code null} 或非正数表示"未配置"，由 {@code WebSearchEngine} 视为不做摘要。
 */
@Builder
public record WebSearchConfig(String baseUrl, String apiKey, Long timeout, Integer maxResult, Integer maxOutput) {

    /**
     * 规范化构造：{@code maxOutput} 缺失或非法时归一为 {@code 0}（未配置），
     * 避免下游各处重复判空，也避免再出现一个魔法默认值。
     */
    public WebSearchConfig {
        if (maxOutput == null || maxOutput <= 0) {
            maxOutput = 0;
        }
    }
}

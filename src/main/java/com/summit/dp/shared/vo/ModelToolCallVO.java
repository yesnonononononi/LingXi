package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

/**
 * AI 行里的「模型请求视图」：模型下发的一次工具调用请求（{@code {id,name,arguments}}）。
 *
 * <p>它只表达「模型请求了什么」，**不是结果来源**——结果统一从 {@code tool_call} 行按
 * {@code callId} 查回（见 {@link ToolCallVO}）。</p>
 */
@Data
@Builder
public class ModelToolCallVO {
    private String id;
    private String name;
    private String arguments;
}

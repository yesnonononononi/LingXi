package com.summit.dp.session.application.convert;

/**
 * 工具块的事件权威事实。
 *
 * <p><b>为什么单独成形</b>：框架的 {@code ToolCallStartEvent} / {@code ToolCallEndEvent} 已经带齐
 * {@code responseId} / {@code requestIndex} / {@code toolName} / {@code args}，单块推送不必再回查
 * 整轮 {@code session_message} 去找「哪个响应请求了它」。跨模块传递时用这个记录，避免工作流层
 * 把框架事件类型漏进会话层的装配器。</p>
 *
 * @param toolCallId   工具调用 ID（块身份 {@code tool:<toolCallId>}）
 * @param responseId   框架下发的模型响应身份（纯数字，由装配器统一校验）
 * @param requestIndex 该调用在所属模型响应里的零基位置（决定块内顺序）
 * @param toolName     模型请求的工具名（工具行缺失时块的展示名）
 * @param args         模型请求的原始参数 JSON 文本
 */
public record ToolBlockEventFacts(String toolCallId, String responseId, int requestIndex,
                                  String toolName, String args) {
}

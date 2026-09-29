package com.summit.dp.toolcall.api.dto;

/**
 * 工具调用决策入参：以 {@code toolCallId} 定位待决策的卡片。
 *
 * <p>废弃旧的 {@code statusId} / {@code sessionId} 定位：卡片权威源是 {@code tool_call} 行，
 * 模型下发的 {@code call_xxx} 即唯一键。</p>
 *
 * @param conversationId 会话 id（= {@code tool_call.conversation_id}），用于归属校验，可为空（不校验）
 * @param toolCallId     工具调用 id（定位键）
 * @param approved       是否批准；缺省按拒绝（宁可让模型多问一次，也不要静默批准）
 * @param text           用户答复原文，可为空
 */
public record ToolCallDecisionRequest(
        Long conversationId,
        String toolCallId,
        Boolean approved,
        String text
) {

    /** 缺省按拒绝。 */
    public boolean isApproved() {
        return Boolean.TRUE.equals(approved);
    }
}

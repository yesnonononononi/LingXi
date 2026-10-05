package com.summit.dp.toolcall.api.dto;

import com.summit.dp.toolcall.domain.model.ToolCallAction;

/**
 * v2 决策请求：以动作判别，不再把「CHOICE 的回答」隐含为 {@code approved=true}。
 *
 * <p><b>为什么必须用动作判别</b>：v1 只有一个 {@code approved} 布尔，CHOICE 的回答
 * 只能借用「批准」来表达。于是「用户选了选项 B」和「用户批准执行这条命令」在库里长得一样，
 * 事后无法区分；而回放、重试、审计全都依赖这个区分。动作判别把语义显式化：
 * {@code APPROVE} 是放行，{@code ANSWER} 是回答，{@code REJECT} 是终态拒绝。</p>
 *
 * <p><b>为什么必须带 expectedVersion</b>：多个标签页 / 多次点击可能基于同一张旧卡片提交。
 * 没有版本号，后到的请求会拿着过期的界面状态覆盖先到的结论，且无法被检测。
 * 版本冲突是可判定的（回 {@code STATE_CONFLICT}），而静默覆盖不可。</p>
 *
 * @param conversationId 会话 id，用于归属校验；可空（不校验）
 * @param toolCallId     工具调用 id（定位键）
 * @param commandId      决策命令身份；同 ID 重试据此返回首次结论
 * @param expectedVersion 客户端看到的卡片版本；与库中不符即 {@code STATE_CONFLICT}
 * @param action         动作判别
 * @param text           用户答复原文（{@code ANSWER} 必填，其余可空）
 */
public record ToolCallDecisionCommand(
        Long conversationId,
        String toolCallId,
        String commandId,
        Long expectedVersion,
        ToolCallAction action,
        String text
) {
}

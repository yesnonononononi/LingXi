package com.summit.dp.session.domain.model;

/**
 * 会话消息类型（落库 session_message.type）。
 *
 * <p>旧的 {@code INTERACTION}（互动快照行）已物理删除：卡片数据一律落在 {@code tool_call} 表，
 * 时间轴只保留模型对话的四种消息。</p>
 *
 * <p><b>{@code ERROR} 已删除（2026-10-01）</b>：执行失败是**轮次的属性**，不是一轮对话里的
 * 一条消息。此前把失败伪装成一条消息塞进时间轴，既污染了消息列表，也让「失败」这个状态
 * 同时存在于两个地方。现在失败只由 {@code chat_turn.status = FAILED} 与
 * {@code chat_turn.error_reason} 承载，由前端挂在回答组上渲染。</p>
 *
 * <p>⚠️ 因此**残留的 {@code type='ERROR'} 行会让 {@code valueOf} 抛异常**，
 * 迁移脚本必须先把它们删干净再部署本版本。</p>
 */
public enum SessionMessageType {
    USER,
    AI,
    TOOL,
    SYSTEM
}

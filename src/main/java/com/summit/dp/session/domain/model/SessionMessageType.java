package com.summit.dp.session.domain.model;

/**
 * 会话消息类型（落库 session_message.type）。
 *
 * <p>旧的 {@code INTERACTION}（互动快照行）已物理删除：卡片数据一律落在 {@code tool_call} 表，
 * 时间轴只保留模型对话的四种消息。</p>
 */
public enum SessionMessageType {
    USER,
    AI,
    TOOL,
    SYSTEM
}

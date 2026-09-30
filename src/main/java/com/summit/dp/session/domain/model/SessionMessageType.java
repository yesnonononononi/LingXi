package com.summit.dp.session.domain.model;

/**
 * 会话消息类型（落库 session_message.type）。
 *
 * <p>旧的 {@code INTERACTION}（互动快照行）已物理删除：卡片数据一律落在 {@code tool_call} 表，
 * 时间轴只保留模型对话的四种消息。</p>
 *
 * <p>{@link #ERROR} 不是模型对话行，而是**执行失败标注行**：执行抛异常时追加一行，承载给人看的
 * 失败文案。它存在的唯一理由是「失败必须可被重新读取」——失败文案此前只活在 SSE 事件里，
 * 流一结束（前端与后端做消息级对账）就再无来源，表现为错误提示一闪即没、刷新会话后彻底消失。</p>
 */
public enum SessionMessageType {
    USER,
    AI,
    TOOL,
    SYSTEM,
    ERROR
}

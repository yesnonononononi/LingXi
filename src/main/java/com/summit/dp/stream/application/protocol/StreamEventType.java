package com.summit.dp.stream.application.protocol;

import java.util.HashMap;
import java.util.Map;

/**
 * v2 流事件的类型唯一真源。
 *
 * <p><b>wire 值一字不可改：</b>前端 {@code types/chat.ts} 与 {@code messageRouter.ts} 按字面量匹配，
 * 任何改名都会静默丢事件。新增类型时先确认前端已有对应用例。</p>
 */
public enum StreamEventType {

    /** 快照首帧：订阅建立时一次全量投影。 */
    STREAM_SNAPSHOT("STREAM_SNAPSHOT"),

    /** 会话实体变更。 */
    SESSION_UPDATED("SESSION_UPDATED"),
    /** 轮次实体变更。 */
    TURN_UPDATED("TURN_UPDATED"),
    /** 执行实体变更。 */
    EXECUTION_UPDATED("EXECUTION_UPDATED"),
    /** 工具调用实体变更。 */
    TOOL_CALL_UPDATED("TOOL_CALL_UPDATED"),

    /** 正文增量帧，只带增量不带全文。 */
    TEXT_DELTA("TEXT_DELTA"),
    /** 思考增量帧。 */
    THINKING_DELTA("THINKING_DELTA"),
    /** 消息定稿帧（打断也走这里，用 payload.interrupted 区分）。 */
    MESSAGE_FINALIZED("MESSAGE_FINALIZED"),
    /** 消息已落库，载荷补齐权威消息行。 */
    MESSAGE_COMMITTED("MESSAGE_COMMITTED"),

    /** 上下文用量变更（框架 CONTEXT_UPDATE 转换而来）。 */
    CONTEXT_UPDATE("CONTEXT_UPDATE"),

    /** 历史代际失效，客户端须丢弃旧投影。 */
    HISTORY_INVALIDATED("HISTORY_INVALIDATED"),

    /** 生命周期事件：由框架 v1 事件透传，state 取 EXECUTION_ 前缀之后的语义。 */
    EXECUTION_STARTED("EXECUTION_STARTED"),
    EXECUTION_RESUME("EXECUTION_RESUME"),
    EXECUTION_SUSPENDED("EXECUTION_SUSPENDED"),
    EXECUTION_COMPLETED("EXECUTION_COMPLETED"),
    EXECUTION_FAILED("EXECUTION_FAILED"),
    EXECUTION_CANCELLED("EXECUTION_CANCELLED"),

    /** 有新的待决卡片，前端据此拉取 ToolCallVO。 */
    CARD_PENDING("CARD_PENDING");

    /** 生命周期事件前缀：v1 事件按此前缀分流，转换时裁出 {@code payload.state} 的语义。 */
    public static final String EXECUTION_LIFECYCLE_PREFIX = "EXECUTION_";

    private static final Map<String, StreamEventType> BY_WIRE_VALUE = new HashMap<>();

    static {
        for (StreamEventType type : values()) {
            BY_WIRE_VALUE.put(type.wireValue, type);
        }
    }

    private final String wireValue;

    StreamEventType(String wireValue) {
        this.wireValue = wireValue;
    }

    /** 下发给客户端的字面量，与 {@link #name()} 当前完全一致。 */
    public String wireValue() {
        return wireValue;
    }

    /** 按 wire 值反查类型；未登记的类型返回 {@code null}（调用方走各自的兜底分支）。 */
    public static StreamEventType fromWireValue(String wireValue) {
        return BY_WIRE_VALUE.get(wireValue);
    }
}

package com.summit.dp.stream.application.protocol;

import java.util.HashMap;
import java.util.Map;

/**
 * v3 流事件的类型唯一真源。
 *
 * <p><b>与 v2 的 {@link StreamEventType} 明确区分</b>：v3 精简了事件集合，去掉了快照、校准、
 * 卡片待查等旧概念，改用「直投帧 + 提交事实」。两者 wire 值可能重名（如 {@code TEXT_DELTA}），
 * 但语义与载荷不同，绝不可混用同一个枚举实例。</p>
 *
 * <p><b>wire 值一字不可改：</b>前端按字面量匹配，任何改名都会静默丢事件。新增类型前先确认
 * 前端已有对应用例。</p>
 */
public enum StreamV3EventType {

    /** 连接登记完成的控制帧；带本连接 connectionId，无业务状态。 */
    STREAM_READY("STREAM_READY"),
    /** 模型调用前声明新 streamKey；前端据此确认自己接收了本响应的起点。 */
    RESPONSE_STARTED("RESPONSE_STARTED"),
    /** 正文增量帧，只追加、不引发查询。 */
    TEXT_DELTA("TEXT_DELTA"),
    /** 思考增量帧，只追加、不引发查询。 */
    THINKING_DELTA("THINKING_DELTA"),
    /** 该响应的权威完整正文、思考及用途；替换对应字段，尚不等于落库。 */
    RESPONSE_FINALIZED("RESPONSE_FINALIZED"),
    /** 同一 streamKey、数据库 messageId 与已提交完整消息；原地绑定。 */
    MESSAGE_COMMITTED("MESSAGE_COMMITTED"),
    /** 完整工具卡片及 version、executionVersion、allowedActions。 */
    TOOL_CALL_UPDATED("TOOL_CALL_UPDATED"),
    /** 执行实体已提交摘要及 version。 */
    EXECUTION_UPDATED("EXECUTION_UPDATED"),
    /** 轮次实体已提交摘要及 version。 */
    TURN_UPDATED("TURN_UPDATED"),
    /** 会话实体已提交摘要及 version。 */
    SESSION_UPDATED("SESSION_UPDATED"),
    /** 新 historyRevision 与作废范围。 */
    HISTORY_INVALIDATED("HISTORY_INVALIDATED");

    /** v3 信封版本。 */
    public static final int SCHEMA_VERSION = 3;

    private static final Map<String, StreamV3EventType> BY_WIRE_VALUE = new HashMap<>();

    static {
        for (StreamV3EventType type : values()) {
            BY_WIRE_VALUE.put(type.wireValue, type);
        }
    }

    private final String wireValue;

    StreamV3EventType(String wireValue) {
        this.wireValue = wireValue;
    }

    /** 下发给客户端的字面量，与 {@link #name()} 当前完全一致。 */
    public String wireValue() {
        return wireValue;
    }

    /** 按 wire 值反查类型；未登记的类型返回 {@code null}。 */
    public static StreamV3EventType fromWireValue(String wireValue) {
        return BY_WIRE_VALUE.get(wireValue);
    }
}

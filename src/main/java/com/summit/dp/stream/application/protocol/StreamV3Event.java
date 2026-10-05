package com.summit.dp.stream.application.protocol;

import java.time.Instant;

/**
 * v3 直投信封（§4）。
 *
 * <p><b>刻意不设</b> {@code seq} / {@code streamEpoch} / {@code projectionStamp}，也不提供
 * {@code Last-Event-ID} 重放：单连接的 FIFO 顺序由传输层保证，跨连接恢复依赖持久化实体版本与
 * 完整响应替换，而不是全局序号。</p>
 *
 * <p>record + Jackson 输出：禁止用 {@code Map.put} 拼 JSON（见 lingxi-harness-conventions）。
 * 身份字段统一为十进制字符串，避免雪花 ID 超出前端 JS 安全整数范围被精度截断。</p>
 *
 * @param schemaVersion   协议版本，恒为 {@link StreamV3EventType#SCHEMA_VERSION}
 * @param eventId         本帧唯一 ID，在发布入口创建一次，同一帧广播给各连接
 * @param rootSessionId   根会话 ID
 * @param sessionId       事件归属会话 ID（子执行取其子会话）
 * @param turnId          业务轮次 ID；未知为 {@code null}
 * @param executionId     执行 ID
 * @param historyRevision 根会话历史代际
 * @param streamKey       响应身份；无身份事件（如会话/轮次变更）为 {@code null}
 * @param type            事件类型 wire 值
 * @param timestamp       事件时间
 * @param data            事件载荷；由各类型的不可变 DTO 提供，可为 {@code null}
 */
public record StreamV3Event(
        int schemaVersion,
        String eventId,
        String rootSessionId,
        String sessionId,
        String turnId,
        String executionId,
        String historyRevision,
        String streamKey,
        String type,
        Instant timestamp,
        Object data) {

    /** 以给定身份构建一帧 v3 事件；协议版本固定写入。 */
    public static StreamV3Event of(String eventId, Identity identity, StreamV3EventType type,
                                   Instant timestamp, Object data) {
        return new StreamV3Event(StreamV3EventType.SCHEMA_VERSION, eventId,
                identity.rootSessionId(), identity.sessionId(), identity.turnId(), identity.executionId(),
                identity.historyRevision(), identity.streamKey(), type.wireValue(), timestamp, data);
    }

    /** 一帧事件的归属身份；缺省字段为 {@code null}。 */
    public record Identity(String rootSessionId, String sessionId, String turnId, String executionId,
                           String historyRevision, String streamKey) {
    }
}

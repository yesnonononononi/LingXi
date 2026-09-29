package com.summit.dp.shared.event;

import java.time.Instant;

/**
 * 统一的卡片事件：语义**只做「有新的 pending 卡片」通知**，卡片载荷的权威源是 {@code tool_call} 行。
 *
 * <p>前端收到后按 {@link #toolCallId} 拉取 {@code ToolCallVO} 建成卡片（与历史路径同一形状），
 * 不再依赖 {@code statusId} / {@code topic} / {@code payload}。</p>
 *
 * <p>{@code rootSessionId} 是事件的归属（推送路由键的回显）：子会话产生的卡片归入根会话的流，
 * 前端据此判定事件属于哪个主任务，不必再从 sessionId 反查。</p>
 *
 * <p>三套旧事件（{@code SUSPENSION} / {@code PLAN_CREATED} / {@code REQUIRE_CHOICE}）合并为本单值事件
 * {@link #TYPE}。</p>
 */
public record ToolCallPendingEvent(
        String type,
        String rootSessionId,
        String toolCallId,
        String cardKind,
        String sessionId,
        String executionId,
        Instant timestamp
) {

    public static final String TYPE = "CARD_PENDING";

    public static ToolCallPendingEvent of(long rootSessionId, String toolCallId, String cardKind,
                                          String sessionId, String executionId) {
        return new ToolCallPendingEvent(TYPE, String.valueOf(rootSessionId), toolCallId, cardKind,
                sessionId, executionId, Instant.now());
    }
}

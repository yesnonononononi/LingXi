package com.summit.dp.shared.event;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 卡片事件发布入口：把 {@link ToolCallPendingEvent} 序列化后按**根会话**定向推送到 SSE。
 *
 * <p>订阅语义沿用 {@link SseEventPublisher#connect(long)} / {@link SseEventPublisher#publish(long, String)}：
 * 子会话产生的卡片事件必须用 rootSessionId 推送。{@code broadcast} 已物理删除，禁止复活。</p>
 */
@Component
@RequiredArgsConstructor
public class ToolCallEventPublisher {

    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;

    /** 按根会话定向推送一张 pending 卡片事件。 */
    public void publish(long rootSessionId, ToolCallPendingEvent event) {
        try {
            sseEventPublisher.publish(rootSessionId, objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to publish tool call event", e);
        }
    }
}

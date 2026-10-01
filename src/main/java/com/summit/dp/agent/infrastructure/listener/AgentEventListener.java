package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.core.conversation.event.*;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.shared.event.SseEventPublisher;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 监听 com.summit.core.conversation.event 包中的全部 Agent 运行时事件，
 * 直接使用 ObjectMapper 序列化为 JSON 广播给 SSE 前端连接。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentEventListener implements RuntimeListener {
    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;



    private interface TypedEventMixIn {
        @JsonProperty("type")
        String type();
    }

    @PostConstruct
    public void init() {
        objectMapper.addMixIn(TypedEvent.class, TypedEventMixIn.class);
    }

    @Override
    public void onExecutionStart(ExecutionStartEvent event) {
        broadcast(event);
    }

    @Override
    public void onToolCall(ToolCallStartEvent event) {
        broadcast(event);
    }

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        broadcast(event);
    }

    @Override
    public void onAiMessage(AgentMessageEvent event) {
        broadcast(event);
    }

    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        broadcast(event);
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        broadcast(event);
    }

    @Override
    public void onExecutionCancelled(ExecutionCancelledEvent event) {
        broadcast(event);
    }

    /**
     * 挂起 / 恢复与其余生命周期事件一样广播：前端据此把会话切到「已暂停待恢复」或切回执行态。
     *
     * <p>挂起事件由 {@code RuntimeProcessorTemplate} 在状态转移并落库后、unregister 前发出。
     * 待审批卡片仍由 {@code LocalExecutionRepository#notifySuspended} 在 unregister 时驱动。</p>
     */
    @Override
    public void onExecutionSuspended(ExecutionSuspendedEvent event) {
        broadcast(event);
    }

    @Override
    public void onExecutionResumed(ExecutionResumedEvent event) {
        broadcast(event);
    }


    @Override
    public void onPartialText(AgentPartialTextEvent event) {
        broadcast(event);
    }

    @Override
    public void onCompleteText(AgentCompleteTextEvent event) {
        broadcast(event);
    }

    @Override
    public void onPartialThinking(AgentPartialThinkingEvent event) {
        broadcast(event);
    }

    @Override
    public void onContextUpdate(ContextUpdateEvent event) {
        broadcast(event);
    }

    /** Business turn identity comes from explicitly selected request metadata, without a lookup. */
    private void broadcast(AgentEvent event) {
        try {
            // HC-3：先解析事件所属的【根】会话再定向推送；解析不出（无 executionId 或
            // 执行已不在库里）就丢弃并告警 —— 不得退回全局广播，跨会话泄露不可接受。
            String executionId = event.executionId();
            if (executionId == null || executionId.isBlank()) {
                log.warn("【agent-event】event without executionId dropped: {}", event);
                return;
            }
            // 复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表。
            long sessionId = executionIdentity.sessionId(executionId);
            long rootSessionId = executionIdentity.rootSessionIdOfSession(sessionId);

            ObjectNode payload = objectMapper.valueToTree(event);
            if (!payload.has("sessionId")) {
                // 数值节点会绕过全局 Long→String 序列化器，ID 必须以字符串写入。
                payload.put("sessionId", Long.toString(sessionId));
            }
            Long turnId = ExecutionEventMetadata.turnId(event.eventMetaData());
            if (turnId != null) {
                payload.put(ExecutionEventMetadata.TURN_ID, turnId.toString());
            }
            sseEventPublisher.publish(rootSessionId, objectMapper.writeValueAsString(payload));
        } catch (JsonProcessingException e) {
            log.error("Error broadcasting event: {}", event, e);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("【agent-event】cannot resolve root session, event dropped: {}", e.getMessage());
        }
    }

}

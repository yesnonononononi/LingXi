package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.execution.ExecutionIdentity;
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
        RuntimeEventType type();
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
     * <p>注意时机：挂起事件由 {@code RuntimeProcessorTemplate} 在 loop 返回 SUSPENDED 后、
     * 「落库 + unregister」之前发出，因此它只表示「已决定挂起」，此刻持久化状态仍是 RUNNING。
     * 依赖已落库状态的动作（推送待审批卡片）仍由 {@code LocalExecutionRepository#notifySuspended}
     * 在 unregister 时驱动，两者职责不同、互不替代。</p>
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
    public void onApplicationEvent(Object event) {
        broadcast(event);
    }

    @Override
    public void onPartialText(AgentPartialTextEvent event) {
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

    private void broadcast(Object event) {
        try {
            ObjectNode payload = objectMapper.valueToTree(event);
            if (payload.hasNonNull("executionId") && !payload.has("sessionId")) {
                try {
                    // 必须以字符串写入：ObjectNode 的数值节点在序列化时会绕过全局的
                    // Long→String 序列化器，雪花 ID 以 JSON 数字下发到前端后，
                    // JS 解析即丢失精度，会话会被绑定到一个不存在的 ID 上。
                    payload.put("sessionId",
                            String.valueOf(executionIdentity.sessionId(payload.get("executionId").asText())));
                } catch (IllegalStateException | NumberFormatException ignored) {
                    // Application events may use an identifier outside the persisted loop.
                }
            }
            // HC-3：先解析事件所属的【根】会话再定向推送；解析不出（无 executionId 或
            // 执行已不在库里）就丢弃并告警 —— 不得退回全局广播，跨会话泄露不可接受。
            if (!payload.hasNonNull("executionId")) {
                log.warn("【agent-event】event without executionId dropped: {}", payload);
                return;
            }
            String executionId = payload.get("executionId").asText();
            long rootSessionId = executionIdentity.rootSessionId(executionId);
            sseEventPublisher.publish(rootSessionId, objectMapper.writeValueAsString(payload));
        } catch (JsonProcessingException e) {
            log.error("Error broadcasting event: {}", event, e);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("【agent-event】cannot resolve root session, event dropped: {}", e.getMessage());
        }
    }
}

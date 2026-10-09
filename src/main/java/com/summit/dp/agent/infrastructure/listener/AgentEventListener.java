package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.event.*;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.vo.block.BlockOrder;
import com.summit.dp.shared.vo.block.Placement;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;


/** 实时事件保留框架偏移，补齐展示位置后按根会话推送，执行终结不关闭会话流。 */
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
        broadcastRenderEvent(event);
    }

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        broadcastRenderEvent(event);
    }

    @Override
    public void onAiMessage(AgentMessageEvent event) {
        broadcastRenderEvent(event);
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
        broadcastRenderEvent(event);
    }

    @Override
    public void onCompleteText(AgentCompleteTextEvent event) {
        broadcastRenderEvent(event);
    }

    @Override
    public void onPartialThinking(AgentPartialThinkingEvent event) {
        broadcastRenderEvent(event);
    }

    private void broadcastRenderEvent(AgentEvent event) {
        BroadcastTarget target = resolveTarget(event);
        if (target == null) return;
        ObjectNode payload = objectMapper.valueToTree(event);
        String responseId = switch (event) {
            case AgentPartialTextEvent text -> text.responseId();
            case AgentPartialThinkingEvent thought -> thought.responseId();
            case AgentCompleteTextEvent text -> text.responseId();
            case AgentMessageEvent message -> message.getResponseId();
            case ToolCallStartEvent tool -> tool.getResponseId();
            case ToolCallEndEvent tool -> tool.getResponseId();
            default -> null;
        };
        if (responseId != null) {
            if (event instanceof AgentPartialTextEvent text && text.content() != null) {
                payload.put("order", BlockOrder.text());
            } else if (event instanceof AgentPartialThinkingEvent thought && thought.content() != null) {
                payload.put("order", BlockOrder.thinking());
            } else if (event instanceof AgentCompleteTextEvent) {
                payload.put("order", BlockOrder.text());
            } else if (event instanceof AgentMessageEvent message) {
                AiMessageEntity aiMessage = message.getChatResponseEntity().getAiMessageEntity();
                // 保留展示契约，完整模型结构只用来确认用途，不再额外缓存。
                payload.remove("chatResponseEntity");
                payload.set("text", objectMapper.valueToTree(aiMessage.text()));
                payload.set("thinking", objectMapper.valueToTree(aiMessage.getThinking()));
                payload.put("placement", Placement.resolve(aiMessage.getToolCalls()).name());
                payload.put("order", BlockOrder.text());
                payload.put("thinkingOrder", BlockOrder.thinking());
            } else if (event instanceof ToolCallStartEvent tool) {
                payload.put("order", BlockOrder.tool(tool.getRequestIndex()));
            } else if (event instanceof ToolCallEndEvent tool) {
                payload.put("order", BlockOrder.tool(tool.getRequestIndex()));
            }
        }
        sseEventPublisher.publishBusiness(target.rootSessionId(), event.type(), payload);
    }

    @Override
    public void onContextUpdate(ContextUpdateEvent event) {
        broadcast(event);
    }

    /** 执行终结只广播，连接由会话流自身的生命周期回收。 */
    private void broadcast(AgentEvent event) {
        BroadcastTarget target = resolveTarget(event);
        if (target == null) {
            return;
        }
        sseEventPublisher.publish(target.rootSessionId(), event);
    }

    /** 无执行归属就丢弃，避免把未知事件送到其它会话。 */
    private BroadcastTarget resolveTarget(AgentEvent event) {
        String executionId = event.executionId();
        if (executionId == null || executionId.isBlank()) {
            log.warn("丢弃缺少执行身份的事件: event={}", event);
            return null;
        }
        try {
            // 复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表。
            long sessionId = executionIdentity.sessionId(executionId);
            long rootSessionId = executionIdentity.resolveRootSessionId(sessionId);
            return new BroadcastTarget(sessionId, rootSessionId);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("丢弃无法定位根会话的事件: reason={}", e.getMessage());
            return null;
        }
    }

    /** 一次广播的落点：执行所属会话与其根会话。 */
    private record BroadcastTarget(long sessionId, long rootSessionId) {
    }
}

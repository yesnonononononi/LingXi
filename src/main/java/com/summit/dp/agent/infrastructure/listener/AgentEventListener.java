package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.event.*;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import cn.hutool.core.util.IdUtil;

import java.time.Instant;
import java.util.Map;

/**
 * 监听 com.summit.core.conversation.event 包中的全部 Agent 运行时事件，按执行自身携带的事件元数据
 * 分流到 v3 直投发布器或 v2 旧投影链。
 *
 * <p><b>分流判据：事件元数据是否携带 {@code rootSessionId}。</b>该键由 {@code RequestPreparer} /
 * {@code DelegationRecorder} / {@code SessionAttributeRestorer} 在「接纳、委派、恢复准备」这些
 * 业务入口一次性写入执行请求，并<b>随执行检查点一起持久化</b>。因此它记录的就是「这个执行属于哪一代
 * 协议」：带了就是 v3 执行，没带就是改造前的旧检查点。用它分流等价于「按执行自身的协议版本分流」，
 * 而非「按订阅参数或请求参数分流」—— 后者在重连时会让同一执行被两条链路同时处理（§13.1）。</p>
 *
 * <p><b>v3 路径零查询</b>：归属（rootSessionId/sessionId/turnId/historyRevision）全部来自事件元数据快照，
 * 不查执行表、不查会话表。旧路径（v2）保持原有两次身份解析，确保并存期旧执行仍可正常投递。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentEventListener implements RuntimeListener {
    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;
    private final EventStreamPublisher v3Publisher;

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

    /**
     * 按事件元数据分流：带 v3 元数据的执行走直投，否则回退旧投影链。
     *
     * <p>两种失败语义都保留：无 executionId 一律丢弃（不得退回全局广播）；v2 路径解析不出根会话也丢弃。</p>
     */
    private void broadcast(AgentEvent event) {
        String executionId = event.executionId();
        if (executionId == null || executionId.isBlank()) {
            log.warn("【agent-event】event without executionId dropped: {}", event);
            return;
        }
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(event.eventMetaData());
        if (rootSessionId != null) {
            publishV3(event, rootSessionId);
            return;
        }
        publishLegacy(event, executionId);
    }

    /** v3 直投：身份全取自事件元数据，零查询。 */
    private void publishV3(AgentEvent event, long rootSessionId) {
        StreamV3EventType type = v3Type(event);
        // 工具生命周期事件不是卡片事实：卡片由 ToolCallReadinessService 在提交后用完整 DTO 下发，
        // 这里再发一帧只会把同一条 TOOL_CALL_UPDATED 通道灌成两种载荷形状。无帧可发即返回。
        if (type == null) {
            return;
        }
        Map<String, Object> metadata = event.eventMetaData();
        String streamKey = ExecutionEventMetadata.streamKey(metadata);
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootSessionId),
                text(metadata, ExecutionEventMetadata.SESSION_ID),
                text(metadata, ExecutionEventMetadata.TURN_ID),
                event.executionId(),
                text(metadata, ExecutionEventMetadata.HISTORY_REVISION),
                streamKey);
        StreamV3Event frame = StreamV3Event.of(String.valueOf(IdUtil.getSnowflakeNextId()), identity,
                type, event.timestamp() == null ? Instant.now() : event.timestamp(), v3Payload(event, streamKey));
        v3Publisher.publish(rootSessionId, frame);
    }

    /**
     * 框架事件 → v3 载荷。
     *
     * <p>只转换直投所需的轻量字段，<b>不做「先序列化原事件 → readTree → 再构造」</b>（§5 禁止该反模式）。
     * 载荷一律用具名 record，不用 {@code Map.of} 临时拼键值 —— 前端按 type 分派到固定 schema，
     * 形状不定会让它解析报错或静默丢字段。</p>
     */
    private Object v3Payload(AgentEvent event, String streamKey) {
        if (event instanceof AgentPartialTextEvent partialText) {
            return new StreamV3Payloads.Delta(streamKey, partialText.content());
        }
        if (event instanceof AgentPartialThinkingEvent partialThinking) {
            return new StreamV3Payloads.Delta(streamKey, partialThinking.content());
        }
        if (event instanceof AgentMessageEvent message) {
            return new StreamV3Payloads.ResponseFinalized(streamKey, message.getText(), message.getThinking(), null);
        }
        // 生命周期事件只带状态语义；返回 null 时事件本身不携带业务载荷。
        return new StreamV3Payloads.ExecutionState(event.type());
    }

    /**
     * 框架事件 → v3 事件类型；不产生 v3 帧的事件返回 {@code null}。
     *
     * <p><b>工具事件刻意不映射到 {@code TOOL_CALL_UPDATED}</b>：该类型是「完整卡片 DTO」的专属通道，
     * 权威下发点是 {@code ToolCallReadinessService}（提交后）与 bootstrap。框架的 {@code TOOL_CALL} /
     * {@code TOOL_COMPLETED} 是工具生命周期信号，不是卡片事实，映射过去会让同一通道出现两种载荷形状。</p>
     *
     * <p>事件名常量取自框架 {@code RuntimeEventType}，不用字面量：框架 javadoc 明确要求下游传输层
     * 通过 {@code RuntimeEventType} 取得类型判别符，避免各自维护硬编码字符串。</p>
     */
    private static StreamV3EventType v3Type(AgentEvent event) {
        if (event instanceof AgentPartialTextEvent) {
            return StreamV3EventType.TEXT_DELTA;
        }
        if (event instanceof AgentPartialThinkingEvent) {
            return StreamV3EventType.THINKING_DELTA;
        }
        if (event instanceof AgentMessageEvent) {
            return StreamV3EventType.RESPONSE_FINALIZED;
        }
        if (event instanceof ToolCallStartEvent || event instanceof ToolCallEndEvent) {
            return null;
        }
        return StreamV3EventType.EXECUTION_UPDATED;
    }

    /** v2 旧投影链：保留原有两次身份解析与 JSON 载荷形状，并存期不破坏旧界面。 */
    private void publishLegacy(AgentEvent event, String executionId) {
        try {
            // 复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表。
            long sessionId = executionIdentity.sessionId(executionId);
            long rootSessionId = executionIdentity.resolveRootSessionId(sessionId);

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

    /** 读元数据字符串值；缺失返回 {@code null}。 */
    private static String text(Map<String, Object> metadata, String key) {
        Object value = metadata.get(key);
        return value == null ? null : value.toString();
    }
}

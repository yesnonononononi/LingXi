package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.*;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 监听 com.summit.core.conversation.event 包中的全部 Agent 运行时事件，把事件序列化后
 * 按根会话定向推送到 SSE。
 *
 * <p>投影协议（v2）与直投协议（v3）已整体移除，本类只保留最基础的「框架事件 → JSON → 根会话广播」。
 * <b>终态事件也只广播、不关流</b>：会话流的存亡跟页面挂载走，不跟某一次执行的生死走
 * （见 {@link #broadcastTerminal}）。</p>
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
        broadcastTerminal(event);
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        broadcastTerminal(event);
    }

    @Override
    public void onExecutionCancelled(ExecutionCancelledEvent event) {
        broadcastTerminal(event);
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
     * 广播一条非终态事件。
     *
     * <p>失败语义：无 executionId 一律丢弃（不得退回全局广播）；解析不出根会话也丢弃。</p>
     */
    private void broadcast(AgentEvent event) {
        BroadcastTarget target = resolveTarget(event);
        if (target == null) {
            return;
        }
        sseEventPublisher.publish(target.rootSessionId(), event);
    }

    /**
 * 终态事件（完成 / 失败 / 取消）：与其它事件<b>同口径广播，不因执行终结而关流</b>。
 *
 * <p><b>为什么终态不关流</b>：会话流是<b>会话级</b>资源，生命周期由前端页面的挂载 / 卸载驱动，
 * 不由某一次执行的生死驱动。若执行一终结就关流，前端在下一次发送之前必须重新挂载，
 * 那个空窗期里的事件无处可去；而挂载与重连本来就是前端自己的事。</p>
 *
 * <p><b>不会有「半死流」泄漏</b>：流的摘除不依赖终结事件 —— 容器回调
 * （{@code onCompletion} / {@code onTimeout} / {@code onError}）与写入失败都会摘流，
 * 心跳每 30s 一次，写不出去即摘。空闲会话的代价只是每30s 一帧心跳，
 * 前端卸载时连接正常结束。</p>
 */
    private void broadcastTerminal(AgentEvent event) {
        broadcast(event);
    }

    /**
     * 解析一次广播的落点：执行所属会话与其根会话（同一把 key 归档 SSE 流）。
     *
     * <p>失败语义：无 executionId 一律丢弃（不得退回全局广播）；解析不出根会话也丢弃，
     * 返回 {@code null} 由调用方短路。</p>
     */
    private BroadcastTarget resolveTarget(AgentEvent event) {
        String executionId = event.executionId();
        if (executionId == null || executionId.isBlank()) {
            log.warn("【agent-event】event without executionId dropped: {}", event);
            return null;
        }
        try {
            // 复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表。
            long sessionId = executionIdentity.sessionId(executionId);
            long rootSessionId = executionIdentity.resolveRootSessionId(sessionId);
            return new BroadcastTarget(sessionId, rootSessionId);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("【agent-event】cannot resolve root session, event dropped: {}", e.getMessage());
            return null;
        }
    }

    /** 一次广播的落点：执行所属会话与其根会话。 */
    private record BroadcastTarget(long sessionId, long rootSessionId) {
    }
}

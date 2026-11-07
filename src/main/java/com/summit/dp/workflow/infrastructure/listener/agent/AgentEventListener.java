package com.summit.dp.workflow.infrastructure.listener.agent;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.event.*;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.vo.block.BlockOrder;
import com.summit.dp.workflow.application.chat.ExecutionErrorText;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 实时事件保留框架偏移，补齐展示位置后按根会话推送，执行终结不关闭会话流。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentEventListener implements RuntimeListener {
    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionLocator executionLocator;
    /** 待收口位读口：成功终态能否发布由这一列决定（见 {@code suppressedWhileClosurePending}）。 */
    private final ExecutionRepository executions;

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
        BroadcastTarget target = resolveTarget(event);
        if (target == null) return;
        ObjectNode payload = objectMapper.valueToTree(event);
        payload.put("errMsg", ExecutionErrorText.resolve(event));
        sseEventPublisher.publishBusiness(target.rootSessionId(), event.type(), payload);
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        if (suppressedWhileClosurePending(event)) {
            return;
        }
        broadcast(event);
    }

    /**
     * 成功终态的通知层门禁：业务收口没做完就不发「完成」。
     *
     * <p><b>为什么必须在这里挡</b>：框架的 {@code RuntimeProcessorTemplate} 在 {@code finally} 里
     * 用 {@code RuntimeUtil.runAll(...)} 逐任务 catch 地跑
     * {@code save → unregister → publish → 成功终态}，也就是<b>收口失败绝不会阻止成功终态发出</b>
     * —— 让收口异常向上抛只会被吞掉，把投影塞进状态提交事务同样躲不过这个 {@code runAll}。
     * 因此唯一能生效的位置就是业务侧自己的终态发布入口。</p>
     *
     * <p><b>判据只有一列：{@code execution.closure_pending}</b>。它不是新状态机，只是「状态已提交、
     * 业务收口没做完」这一事实本身；为 1 就意味着收口脚本没走完，此刻发「完成」会让界面显示完成
     * 而业务轮次还在进行中。本方法<b>只读</b>这一列，不写、不改任何状态流转。</p>
     *
     * <p><b>谁来补发</b>：清位之后由补偿路径（启动收口）补一次成功终态；补发与否同样看这一列
     * —— 第二遍发现它已是 0，就不会重复发。也就是说「是否已发布过」这个事实由库里的待收口位承载，
     * 不靠内存标记。</p>
     *
     * @return 已拦截返回 {@code true}（不广播）
     */
    private boolean suppressedWhileClosurePending(ExecutionCompleteEvent event) {
        String executionId = event.executionId();
        if (executionId == null || executionId.isBlank()) {
            return false;
        }
        boolean pending;
        try {
            pending = executions.isClosurePending(Long.parseLong(executionId));
        } catch (RuntimeException ignored) {
            // 读不到就不拦：宁可多推一帧，也不要因为一次查询失败让用户永远看不到完成。
            return false;
        }
        if (!pending) {
            return false;
        }
        log.warn("业务收口未完成，暂不发布成功终态: executionId={}, closure_pending=1", executionId);
        return true;
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
    public void onInvokeRetry(InvokeRetryEvent event) {
        BroadcastTarget target = resolveTarget(event);
        if (target == null) return;
        ObjectNode payload = objectMapper.valueToTree(event);
        // 全局 Long 序列化保护雪花标识，等待时长仍按数值交付。
        payload.put("retryDelay", event.getRetryDelay());
        sseEventPublisher.publishBusiness(target.rootSessionId(), event.type(), payload);
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
                // 本通道在响应下发时执行尚未终结，无法判断「是否随后挂起」（框架可在此后返回 suspended），
                // 因此结构上恒为非正文。正文归属由轮次终态快照（TurnViewSnapshot → TurnViewAssembler，
                // 同一规则 BodyPlacement.resolve）在轮次 COMPLETED 时升级为 true。
                payload.put("isBody", false);
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

    /**
     * 解析本次广播的落点（所属会话 + 根会话）。
     *
     * <p>流式分片一次回答有数百个 Token 块，为每个块查两次库会把「转发」变成数据库热点：
     * 框架事件在构造时已带上 {@link ExecutionEventMetadata} 的归属快照，能读到的就零查库。</p>
     *
     * <p>元数据缺失时回退执行归属查询，且<b>不加本地缓存</b>：旧检查点可能没有这两个键，
     * 缓存只对「仍在上报的旧执行」有意义，却要额外承担失效、容量与并发三份复杂度，
     * 收益远低于风险。自愈路径是下一轮执行 —— 新构造的元数据一律带全键，回退随即消失。</p>
     *
     * <p>两处都拿不到归属就丢弃：宁可少推一帧，也绝不把未知事件改投到别的会话。</p>
     */
    private BroadcastTarget resolveTarget(AgentEvent event) {
        String executionId = event.executionId();
        if (executionId == null || executionId.isBlank()) {
            log.warn("丢弃缺少执行身份的事件: event={}", event);
            return null;
        }
        BroadcastTarget fromMetadata = resolveTargetFromMetadata(event);
        if (fromMetadata != null) {
            return fromMetadata;
        }
        try {
            // 复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表。
            long sessionId = executionLocator.sessionId(executionId);
            long rootSessionId = executionLocator.resolveRootSessionId(sessionId);
            return new BroadcastTarget(sessionId, rootSessionId);
        } catch (IllegalStateException | NumberFormatException e) {
            log.warn("丢弃无法定位根会话的事件: reason={}", e.getMessage());
            return null;
        }
    }

    /**
     * 从事件元数据解析归属；两个键缺一即返回 {@code null} 交由兜底路径。
     *
     * <p>复用 {@link ExecutionEventMetadata} 的解析规则，不另写一份键名与格式判断：
     * 元数据键是十进制字符串，缺失或不可解析返回 {@code null}。</p>
     */
    private static BroadcastTarget resolveTargetFromMetadata(AgentEvent event) {
        Map<String, Object> metadata = event.eventMetaData();
        Long sessionId = ExecutionEventMetadata.sessionId(metadata);
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(metadata);
        if (sessionId == null || rootSessionId == null) {
            return null;
        }
        return new BroadcastTarget(sessionId, rootSessionId);
    }

    /** 一次广播的落点：执行所属会话与其根会话。 */
    private record BroadcastTarget(long sessionId, long rootSessionId) {
    }
}

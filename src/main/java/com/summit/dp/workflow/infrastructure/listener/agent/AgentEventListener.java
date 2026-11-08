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
import com.summit.dp.session.application.service.SessionTokenAuditCollector;
import com.summit.dp.workflow.application.chat.ExecutionErrorText;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 实时事件保留框架偏移，补齐展示位置后按根会话推送，执行终结不关闭会话流。
 *
 * <p><b>迁移标注（过渡接线）</b>：本类对 {@code onAuditRecorded} / {@code onAuditFailed} 的两个覆写
 * 是<b>过渡接线</b>，待 workflow 统一 {@code ExecutionLifecycleProjectionListener} 落地后迁移到该统一投影，
 * 届时本类的这两个方法应删除，只保留渲染事件与终态的转发职责。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AgentEventListener implements RuntimeListener {
    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionLocator executionLocator;
    /** 待收口位读口：成功终态能否发布由这一列决定（见 {@code suppressedWhileClosurePending}）。 */
    private final ExecutionRepository executions;
    /**
     * token 审计采集器（{@code session} 模块的纯服务）。
     *
     * <p><b>为什么工作流可以直接持有它</b>：{@code WorkflowDependencyTest} 只禁止业务模块
     * 反向依赖工作流，以及工作流直接访问业务的<b>持久化实现</b>；{@code session.application.service}
     * 属于应用层，与 {@code TurnViewBroadcaster} 直接调用 {@code session.application.*} 同一先例。</p>
     */
    private final SessionTokenAuditCollector sessionTokenAuditCollector;

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
     * <p><b>读库失败按「未知即暂缓」（fail-closed）</b>：查询抛异常时返回 {@code true}
     * —— 不发布成功终态，并留一条带 {@code executionId} 的 warn 日志。</p>
     *
     * <p><b>这是刻意取向的修订，与原实现相反</b>。原实现读不到就照常发布（fail-open），
     * 理由是「宁可多发一帧，也别让用户永久看不到完成」。但那份代价方向选错了：读不到待收口位
     * 时我们<b>并不知道</b>收口是否已完成，此时发布成功终态等于<b>可能提前声称业务成功</b>
     * —— 界面显示完成、而轮次 / 卡片 / 子执行可能还在进行，用户据此继续操作就会踩到不一致。
     * 「看不到完成」只是延迟，且是可修复的缺帧；「错误地声称成功」则是事实错误。</p>
     *
     * <p><b>缺帧由权威快照修复，不需要另建状态机</b>：被暂缓的这一帧由权威 bootstrap 与轮次
     * 终态快照收敛 —— 订阅方本来就能靠这两条路径补齐终态，因此暂缓不会造成「永久看不到完成」。
     * 所以这里既不需要「已发布」列，也不需要去重表，判据仍然只有 {@code closure_pending} 一列。</p>
     *
     * <p><b>已知残留：会在「清位」与「发布」之间丢一帧</b>。崩溃若恰好落在补偿路径
     * 「清掉 closure_pending」之后、「补发成功终态」之前，这一帧 SSE 成功通知就永久丢失：该执行
     * 已是终态、待收口位已是 0，之后没有任何路径会再发一次。此时<b>业务事实（轮次 / 卡片 /
     * 子执行 / 用量）都已落库</b>，客户端靠 bootstrap 与轮次终态快照能收敛到「已完成」，因此只是
     * 少一帧实时通知，不是状态错乱。要彻底消除得新增「已发布」列或去重表，那等于给这一列判据
     * 另起一套状态机，与本批「一列判据、不加状态机」的取舍冲突，留待后续。</p>
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
        } catch (RuntimeException failure) {
            // 未知即暂缓：读不到待收口位就无从判断收口是否完成，宁可暂缓成功事件被权威快照补齐，
            // 也不能提前声称业务成功。异常信息必须记下来，否则线上无从定位。
            log.warn("待收口位查询失败，暂缓发布成功终态，等待权威快照收敛: executionId={}, error={}, message={}",
                    executionId, failure.getClass().getSimpleName(), failure.getMessage());
            return true;
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

    /**
     * token 审计成功事件 → 采集并落库（<b>过渡接线</b>，待 workflow 统一
     * {@code ExecutionLifecycleProjectionListener} 落地后迁移到该统一投影）。
     *
     * <p><b>只认 {@link AgentTokenAuditRecordedEvent}</b>：{@link AgentAuditRecordedEvent} 是审计类事件的
     * 公共父接口，将来可能出现别的审计实现（其他口径 / 其他模型），把它们的载荷当成本口径的
     * {@code contextAudit} 会污染快照。因此这里用 {@code instanceof} 过滤，其它实现类型直接忽略。</p>
     *
     * <p><b>必须吞异常</b>：审计采集是旁路动作，任何失败都不许影响执行终态 ——
     * 框架的监听器调用发生在状态提交路径上，异常外抛会污染执行结果。这里捕获
     * {@link RuntimeException} 并记 warn（含 {@code executionId}，便于定位）。</p>
     *
     * @param event 审计成功事件（框架回调）
     */
    @Override
    public void onAuditRecorded(AgentAuditRecordedEvent event) {
        if (!(event instanceof AgentTokenAuditRecordedEvent tokenAudit)) {
            // 其它审计实现类型不属于本口径：忽略（不是错误，不记 warn 以免噪声）。
            return;
        }
        try {
            sessionTokenAuditCollector.collect(event.executionId(), tokenAudit.contextAudit(),
                    event.eventMetaData());
        } catch (RuntimeException failure) {
            // 审计失败绝不影响执行终态：落库没做完就等下一次采集，前端仍可 GET 到旧快照。
            log.warn("token 审计采集失败，已忽略: executionId={}, error={}, message={}",
                    event.executionId(), failure.getClass().getSimpleName(), failure.getMessage());
        }
    }

    /**
     * token 审计失败事件 → 记失败态（<b>过渡接线</b>，待 workflow 统一
     * {@code ExecutionLifecycleProjectionListener} 落地后迁移）。
     *
     * <p>同样只认 {@link AgentTokenAuditFailedEvent}；同样吞异常只记 warn。</p>
     *
     * @param event 审计失败事件（框架回调）
     */
    @Override
    public void onAuditFailed(AgentAuditFailedEvent event) {
        if (!(event instanceof AgentTokenAuditFailedEvent tokenAudit)) {
            return;
        }
        try {
            sessionTokenAuditCollector.markFailed(event.executionId(), tokenAudit.errorType(),
                    tokenAudit.errorMessage(), event.eventMetaData());
        } catch (RuntimeException failure) {
            log.warn("token 审计失败态记录失败，已忽略: executionId={}, error={}, message={}",
                    event.executionId(), failure.getClass().getSimpleName(), failure.getMessage());
        }
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

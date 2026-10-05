package com.summit.dp.stream.infrastructure.listener;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.shared.event.CommittedStateObserver;
import com.summit.dp.shared.vo.ModelToolCallVO;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/**
 * 把「已提交的实体事实」直投为 v3 帧（{@code MESSAGE_COMMITTED} / {@code TURN_UPDATED} /
 * {@code SESSION_UPDATED} / {@code HISTORY_INVALIDATED}）。
 *
 * <p><b>为什么不复用旧 StreamEntityPublisher 适配器</b>：那批适配器只拿到实体 id，必须回查一次
 * 才够构造帧；而 v3 的硬要求是「发送时不重新查库」。本类只读 {@link CommittedStateChange}
 * 里随通知下发的<b>不可变快照</b>与<b>根身份</b>（生产者在写库那一刻两样都有），因此全程零查询。</p>
 *
 * <p><b>根身份为什么必须由生产者带</b>：投递目标是根会话，实体归属是自身会话。子会话的提交
 * 若按自身会话投递，会落进子会话连接桶，而前端只订阅根连接 —— 帧被静默丢弃、不报任何错。
 * 观察者拿不到执行元数据，回查就等于每次提交都反查一次；因此根身份沿业务服务透传到提交事实。
 * 缺失根身份时本类**跳过并告警**，不回落自身会话 —— 回落正是那条静默故障本身。</p>
 *
 * <p><b>提交后语义由上游保证</b>：通知来自 {@code CommittedStatePublisher}，它只在
 * {@code afterCommit} 回调里触达观察者 —— 事务回滚根本走不到这里。本类不再自行判断事务状态，
 * 否则会与上游重复实现、且容易在无事务场景误发。</p>
 *
 * <p><b>链路隔离</b>：直投走 {@link EventStreamPublisher}（v3 自己的连接注册表），
 * 不经 {@code SessionStreamHub}，因此不会引入旧投影的查询、也不会产生第二套响应身份。
 * 与 v2 适配器并存不构成重复：两套发布器维护各自的连接表，订阅哪个版本只收哪个版本的帧。</p>
 *
 * <p><b>发帧失败不影响已提交的业务结论</b>：异常只记 error，不向调用方抛出 —— 通知是旁路，
 * 前端有 bootstrap 兜底。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CommittedStateV3Observer implements CommittedStateObserver {

    private final EventStreamPublisher publisher;
    private final ChatTurnConverter turnConverter;
    private final ObjectMapper json;

    @Override
    public void changed(CommittedStateChange change) {
        try {
            switch (change.kind()) {
                case MESSAGE -> publishMessageCommitted(change);
                case TURN -> publishTurnUpdated(change);
                case SESSION -> publishSessionUpdated(change);
                case HISTORY -> publishHistoryInvalidated(change);
                default -> {
                    // 其余实体（TOOL/EXECUTION）已有各自的 v3 生产路径，不在此重复下发。
                }
            }
        } catch (RuntimeException error) {
            log.error("v3 提交事件下发失败: kind={}, id={}, error={}", change.kind(), change.id(), error.toString());
        }
    }

    /**
     * {@code MESSAGE_COMMITTED}：同一 streamKey 的落库消息身份。
     *
     * <p><b>身份一致是硬要求</b>：{@code streamKey} 取自消息行自身（由
     * {@code TranscriptRecordAssembler} 在写入时落盘），与实时增量同源，
     * 前端才能把这条提交合并进已有气泡而不是新起一条。</p>
     */
    private void publishMessageCommitted(CommittedStateChange change) {
        SessionMessage message = payload(change, SessionMessage.class);
        if (message == null) {
            return;
        }
        // SYSTEM 行是框架内部上下文，不进入用户可见历史（与 v2 适配器同一口径）。
        if (message.getType() == SessionMessageType.SYSTEM) {
            return;
        }
        Long sessionId = message.getSessionId();
        if (sessionId == null) {
            log.warn("提交消息缺少会话归属，跳过 MESSAGE_COMMITTED: messageId={}", message.getId());
            return;
        }
        // ★ 投递用根会话、归属用自身会话。根身份由生产者在写库那一刻随事实带下来
        //   （子会话消息若按自身会话投递会落到子会话连接桶，而前端只订阅根连接 —— 那条消息
        //   就永远收不到，子代理的正文在根会话里凭空缺失）。
        Long rootSessionId = change.rootSessionId();
        if (rootSessionId == null) {
            // 生产者没带根身份：跳过并告警，而不是猜。猜错就是「静默投错桶」，
            // 那正是这条链路最难查的故障形态。缺失只可能来自尚未透传根身份的调用方。
            log.warn("提交消息缺少根身份，跳过 MESSAGE_COMMITTED: messageId={}, sessionId={}",
                    message.getId(), sessionId);
            return;
        }
        MessageContent content = resolveContent(message);
        StreamV3Payloads.MessageCommitted payload = new StreamV3Payloads.MessageCommitted(
                message.getStreamKey(),
                String.valueOf(message.getId()),
                String.valueOf(sessionId),
                message.getTurnId() == null ? null : String.valueOf(message.getTurnId()),
                content.text(),
                content.thinking(),
                content.toolCalls(),
                message.getType().name());
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootSessionId), String.valueOf(sessionId),
                message.getTurnId() == null ? null : String.valueOf(message.getTurnId()),
                null, null, message.getStreamKey());
        publisher.publish(rootSessionId, frame(identity, StreamV3EventType.MESSAGE_COMMITTED, payload));
    }

    /** {@code TURN_UPDATED}：轮次实体摘要（含终值 version），按 version 合并。 */
    private void publishTurnUpdated(CommittedStateChange change) {
        ChatTurn turn = payload(change, ChatTurn.class);
        if (turn == null || turn.getSessionId() == null) {
            return;
        }
        // 同上：子会话轮次也必须投到根连接，否则根会话里的子代理用量/状态永远不更新。
        Long rootSessionId = change.rootSessionId();
        if (rootSessionId == null) {
            log.warn("提交轮次缺少根身份，跳过 TURN_UPDATED: turnId={}, sessionId={}",
                    turn.getId(), turn.getSessionId());
            return;
        }
        // 载荷即 ChatTurnVO 本身（前端按 data.turnId / data.version 直接合并），不再多套一层。
        Object view = turnConverter.toVO(turn, Instant.now());
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootSessionId), String.valueOf(turn.getSessionId()),
                String.valueOf(turn.getId()),
                turn.getExecutionId() == null ? null : String.valueOf(turn.getExecutionId()), null, null);
        publisher.publish(rootSessionId, frame(identity, StreamV3EventType.TURN_UPDATED, view));
    }

    /** {@code SESSION_UPDATED}：会话实体摘要（含 version / historyRevision），按 version 合并。 */
    private void publishSessionUpdated(CommittedStateChange change) {
        Session session = payload(change, Session.class);
        if (session == null || session.getId() == null) {
            return;
        }
        // 子会话事件同样路由到根会话的连接：前端按实体自身 sessionId 定位，不需要额外解析。
        long rootSessionId = session.isSubSession() ? session.getRootSessionId() : session.getId();
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootSessionId), String.valueOf(session.getId()), null, null,
                String.valueOf(session.getHistoryRevision()), null);
        publisher.publish(rootSessionId, frame(identity, StreamV3EventType.SESSION_UPDATED, session));
    }

    /** {@code HISTORY_INVALIDATED}：新代际 + 作废范围，前端据此范围化作废旧代际事实。 */
    private void publishHistoryInvalidated(CommittedStateChange change) {
        if (change.historyRevision() == null || change.sessionId() == null) {
            log.warn("历史失效通知缺少根会话或代际，跳过: id={}", change.id());
            return;
        }
        Long rootSessionId = change.rootSessionId() == null ? change.sessionId() : change.rootSessionId();
        // ★ 范围必须透传：提交事实已经算好了「哪些轮次/执行被物理删除」，观察者只是搬运工。
        //   缺了它，前端只能把整棵根会话历史清空 —— 重发点之前的有效轮次会一起消失。
        StreamV3Payloads.HistoryInvalidated payload = new StreamV3Payloads.HistoryInvalidated(
                String.valueOf(rootSessionId), String.valueOf(change.historyRevision()),
                List.copyOf(change.turnIds()), List.copyOf(change.executionIds()));
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootSessionId), String.valueOf(rootSessionId), null, null,
                String.valueOf(change.historyRevision()), null);
        publisher.publish(rootSessionId, frame(identity, StreamV3EventType.HISTORY_INVALIDATED, payload));
    }

    /** 构造一帧 v3 事件；{@code eventId} 每次发布生成一次，同一帧广播给各连接。 */
    private StreamV3Event frame(StreamV3Event.Identity identity, StreamV3EventType type, Object payload) {
        return StreamV3Event.of(String.valueOf(IdUtil.getSnowflakeNextId()), identity, type, Instant.now(), payload);
    }

    /**
     * 取通知携带的实体快照；类型不符或缺失时返回 {@code null}。
     *
     * <p>快照缺失说明生产者走的是不带事实的旧入口（如启动领养扫描只投影了 id/会话）——
     * 这类低频路径不回查、直接跳过，由前端 bootstrap 兜底。</p>
     */
    private <T> T payload(CommittedStateChange change, Class<T> type) {
        Object payload = change.payload();
        if (payload == null) {
            return null;
        }
        if (!type.isInstance(payload)) {
            log.warn("提交通知载荷类型不符，跳过: kind={}, expected={}, actual={}",
                    change.kind(), type.getSimpleName(), payload.getClass().getSimpleName());
            return null;
        }
        return type.cast(payload);
    }

    /**
     * 解析消息行的展示内容（正文 / 思考 / 工具请求）。
     *
     * <p>消息行 {@code text} 存的是<b>序列化后的 JSON 实体</b>（见 {@code TranscriptRecordAssembler}），
     * 直接下发会把转义引号当成正文渲染。这里按多态反序列化取纯文本。</p>
     *
     * <p>必须<b>覆盖全部消息类型</b>：实体都实现 {@link Message} 且以 {@code type} 作判别字段，
     * 按接口一次解析即可。曾经只处理 AI 行，USER 行原样下发 JSON，前端把
     * {@code {"content":[...],"type":"USER"}} 当正文渲染。</p>
     *
     * <p>AI 行额外取 {@code thinking} 与 {@code toolCalls}：这两个字段只存在于落库行，
     * 实时通道没有别的来源（不发 {@code TOOL_CALL_UPDATED}），漏掉就等于前端回答结束后
     * 看不到思考过程与任何工具痕迹。</p>
     *
     * <p>解析不出内容时<b>返回空内容而非原文</b>：原文是 JSON，退回等于把机器格式灌进展示层。
     * 内容缺失是可接受的降级，展示 JSON 不是。</p>
     */
    private MessageContent resolveContent(SessionMessage message) {
        String stored = message.getText();
        if (stored == null || stored.isBlank()) {
            return MessageContent.EMPTY;
        }
        try {
            Message parsed = json.readValue(stored, Message.class);
            if (parsed instanceof AiMessageEntity ai) {
                return new MessageContent(ai.text(), ai.getThinking(), toModelToolCalls(ai.getToolCalls()));
            }
            return new MessageContent(parsed.text(), null, null);
        } catch (Exception error) {
            log.warn("提交消息内容解析失败，内容置空: messageId={}, error={}", message.getId(), error.getMessage());
            return MessageContent.EMPTY;
        }
    }

    /** 框架的工具请求 → 展示 VO（同形状，仅跨层转换）。 */
    private List<ModelToolCallVO> toModelToolCalls(List<ToolCallRequest> requests) {
        if (requests == null || requests.isEmpty()) {
            return List.of();
        }
        return requests.stream()
                .map(request -> ModelToolCallVO.builder()
                        .id(request.id())
                        .name(request.name())
                        .arguments(request.arguments())
                        .build())
                .toList();
    }

    /** 消息行的展示内容；无内容的类型（USER/TOOL 等）思考与工具为空。 */
    private record MessageContent(String text, String thinking, List<ModelToolCallVO> toolCalls) {

        private static final MessageContent EMPTY = new MessageContent(null, null, List.of());
    }
}

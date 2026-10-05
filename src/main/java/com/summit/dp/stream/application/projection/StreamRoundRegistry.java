package com.summit.dp.stream.application.projection;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.protocol.StreamOperation;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** 同执行当前只允许一个模型调用；父子执行分别分配响应身份。 */
@Component
@RequiredArgsConstructor
public class StreamRoundRegistry {

    /** 幂等预留有界，避免注册缓存随模型调用数量持续增长。 */
    private static final int MAX_RESERVATIONS = 32;

    /** 已提交身份有界，避免回滚回调误释放已接纳的预留。 */
    private static final int MAX_COMMITTED_KEYS = 32;

    /** 模型的 finishReason：工具调用触发，本轮正文只是过程（process）。 */
    private static final String FINISH_REASON_TOOL_EXECUTION = "TOOL_EXECUTION";
    /** 模型的 finishReason：正常收尾，本轮正文即最终答复（answer）。 */
    private static final String FINISH_REASON_STOP = "STOP";

    /** 结束本轮的事件类型（打断也发同一类型，用 payload.interrupted 区分）。 */
    private static final String MESSAGE_FINALIZED = StreamEventType.MESSAGE_FINALIZED.wireValue();
    /** 三个会打断本轮正文的事件：挂起 / 失败 / 取消。 */
    private static final Set<String> INTERRUPTING_TYPES = Set.of(
            StreamEventType.EXECUTION_SUSPENDED.wireValue(),
            StreamEventType.EXECUTION_FAILED.wireValue(),
            StreamEventType.EXECUTION_CANCELLED.wireValue());
    /** 挂起与失败/取消的区别：挂起时已收尾的本轮不回填，只有未收尾的被打断。 */
    private static final String EXECUTION_SUSPENDED = StreamEventType.EXECUTION_SUSPENDED.wireValue();
    /**
     * 以下三个是<b>框架 v1 上游事件</b>，不是本模块下发的 v2 投影事件，
     * 因此 {@link StreamEventType} 里没有对应项，只能在此就地定义。
     * 改它们等于改框架的输出契约。
     */
    /** 思考增量与正文增量的分界：两者累加到不同字段，不可混判。 */
    private static final String PARTIAL_THINKING = "PARTIAL_THINKING";
    /** 整体覆盖正文的事件：它给的是权威全文，不是增量。 */
    private static final String COMPLETE_TEXT = "COMPLETE_TEXT";
    /** 一次性给出完整 AI 消息的事件。 */
    private static final String AI_MESSAGE = "AI_MESSAGE";
    /** 正文增量事件，与 {@link #PARTIAL_THINKING} 同为 v1 上游。 */
    private static final String PARTIAL_TEXT = "PARTIAL_TEXT";
    /** 两个增量事件：只往当前轮追加，不定稿。 */
    private static final Set<String> DELTA_TYPES = Set.of(PARTIAL_TEXT, PARTIAL_THINKING);
    /** 会开启/推进一轮正文的事件，其余事件不参与本轮状态机。 */
    private static final Set<String> ROUND_TEXT_TYPES = Set.of(
            PARTIAL_TEXT,
            PARTIAL_THINKING,
            COMPLETE_TEXT,
            AI_MESSAGE);

    private final ObjectMapper json;
    private final Map<String, Rounds> executions = new ConcurrentHashMap<>();

    public List<StreamOperation> accept(String sessionId, String turnId, String revision, JsonNode event) {
        String executionId = event.path("executionId").asText();
        Rounds rounds = executions.computeIfAbsent(executionId, ignored -> new Rounds());
        synchronized (rounds) {
            String type = event.path("type").asText();
            if (ROUND_TEXT_TYPES.contains(type)) {
                if (rounds.current == null || rounds.current.returned) {
                    rounds.current = new Round(String.valueOf(IdUtil.getSnowflakeNextId()), sessionId, turnId, revision);
                    rounds.pending.add(rounds.current);
                }
                Round round = rounds.current;
                ObjectNode payload = json.createObjectNode();
                String outputType;
                if (DELTA_TYPES.contains(type)) {
                    boolean thinking = PARTIAL_THINKING.equals(type);
                    String delta = event.path("content").asText("");
                    String previous = thinking ? round.thinking : round.text;
                    if (thinking) round.thinking += delta; else round.text += delta;
                    payload.put("blockId", round.key + (thinking ? ":thinking" : ":text"));
                    payload.put("fromOffset", previous.length());
                    payload.put("toOffset", previous.length() + delta.length());
                    payload.put("delta", delta);
                    outputType = thinking
                            ? StreamEventType.THINKING_DELTA.wireValue()
                            : StreamEventType.TEXT_DELTA.wireValue();
                } else {
                    if (COMPLETE_TEXT.equals(type)) {
                        round.text = event.path("content").asText("");
                        round.finishReason = event.path("meta").path("finishReason").asText(null);
                        if (FINISH_REASON_TOOL_EXECUTION.equals(round.finishReason)) round.purpose = "process";
                        else if (FINISH_REASON_STOP.equals(round.finishReason)) round.purpose = "answer";
                    } else {
                        round.text = event.path("text").asText("");
                        if (event.hasNonNull("thinking")) round.thinking = event.path("thinking").asText("");
                        round.returned = true;
                    }
                    outputType = MESSAGE_FINALIZED;
                }
                round.version++;
                payload.set("message", view(round));
                return List.of(StreamOperation.create(sessionId, turnId, executionId, revision, outputType, payload));
            }
            if (FINISH_REASON_TOOL_EXECUTION.equals(type) && rounds.current != null) {
                rounds.current.purpose = "process";
                rounds.current.version++;
                ObjectNode payload = json.createObjectNode().set("message", view(rounds.current));
                return List.of(StreamOperation.create(sessionId, turnId, executionId, revision, MESSAGE_FINALIZED, payload));
            }
            if (INTERRUPTING_TYPES.contains(type)) {
                List<StreamOperation> interrupted = new ArrayList<>();
                boolean terminal = !EXECUTION_SUSPENDED.equals(type);
                for (Round round : List.copyOf(rounds.pending)) {
                    if (!round.returned || terminal) {
                        round.interrupted = true;
                        round.version++;
                        ObjectNode payload = json.createObjectNode().set("message", view(round));
                        interrupted.add(StreamOperation.create(round.sessionId, round.turnId, executionId,
                                round.revision, MESSAGE_FINALIZED, payload));
                        rounds.pending.remove(round);
                        if (rounds.current == round) rounds.current = null;
                    }
                }
                return interrupted;
            }
            return List.of();
        }
    }

    /** 预留不消费，只有真实提交后才移出待接纳队列。 */
    public Reservation reserve(String executionId, AiMessageEntity message) {
        Rounds rounds = executions.computeIfAbsent(executionId, ignored -> new Rounds());
        synchronized (rounds) {
            Reservation previous = rounds.reservations.get(message);
            if (previous != null) return previous;
            Round next = rounds.pending.stream().filter(value -> value.returned && !value.interrupted && !value.reserved).findFirst().orElse(null);
            if (next == null) {
                next = rounds.current != null && !rounds.current.returned && !rounds.current.interrupted
                        ? rounds.current : new Round(String.valueOf(IdUtil.getSnowflakeNextId()), null, null, null);
                next.returned = true;
                next.text = message.text() == null ? "" : message.text();
                next.thinking = message.getThinking() == null ? "" : message.getThinking();
                if (!rounds.pending.contains(next)) rounds.pending.add(next);
            }
            next.reserved = true;
            Reservation reservation = new Reservation(executionId, next.key, message);
            rounds.reservations.put(message, reservation);
            rounds.reservationOrder.add(message);
            while (rounds.reservationOrder.size() > MAX_RESERVATIONS) rounds.reservations.remove(rounds.reservationOrder.remove());
            return reservation;
        }
    }

    public void committed(Reservation reservation) {
        if (reservation == null) return;
        Rounds rounds = executions.get(reservation.executionId());
        if (rounds == null) return;
        synchronized (rounds) {
            rounds.pending.removeIf(value -> value.key.equals(reservation.streamKey()));
            rounds.committedKeys.add(reservation.streamKey());
            while (rounds.committedKeys.size() > MAX_COMMITTED_KEYS) rounds.committedKeys.remove(rounds.committedKeys.iterator().next());
        }
    }

    public void release(Reservation reservation) {
        if (reservation == null) return;
        Rounds rounds = executions.get(reservation.executionId());
        if (rounds == null) return;
        synchronized (rounds) {
            if (rounds.committedKeys.contains(reservation.streamKey())) return;
            rounds.pending.stream().filter(value -> value.key.equals(reservation.streamKey())).forEach(value -> value.reserved = false);
            rounds.reservations.remove(reservation.message());
            rounds.reservationOrder.removeIf(value -> value == reservation.message());
        }
    }
    public void invalidate(Collection<String> executionIds) { executionIds.forEach(executions::remove); }

    private ObjectNode view(Round round) {
        ObjectNode view = json.createObjectNode();
        view.put("streamKey", round.key);
        view.put("blockVersion", String.valueOf(round.version));
        view.put("text", round.text);
        view.put("thinking", round.thinking);
        view.put("textOffset", round.text.length());
        view.put("thinkingOffset", round.thinking.length());
        view.put("purpose", round.purpose);
        view.put("finalized", round.returned);
        view.put("interrupted", round.interrupted);
        if (round.finishReason != null) view.put("finishReason", round.finishReason);
        return view;
    }

    public record Reservation(String executionId, String streamKey, AiMessageEntity message) { }
    private static final class Rounds {
        private Round current;
        private final List<Round> pending = new ArrayList<>();
        private final Map<AiMessageEntity, Reservation> reservations = new IdentityHashMap<>();
        private final Queue<AiMessageEntity> reservationOrder = new ArrayDeque<>();
        private final Set<String> committedKeys = new LinkedHashSet<>();
    }
    private static final class Round {
        private final String key;
        private final String sessionId;
        private final String turnId;
        private final String revision;
        private String text = "";
        private String thinking = "";
        private String purpose = "undetermined";
        private String finishReason;
        private long version;
        private boolean returned;
        private boolean reserved;
        private boolean interrupted;
        private Round(String key, String sessionId, String turnId, String revision) {
            this.key = key; this.sessionId = sessionId; this.turnId = turnId; this.revision = revision;
        }
    }
}

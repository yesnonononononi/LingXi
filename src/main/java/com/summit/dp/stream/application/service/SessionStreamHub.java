package com.summit.dp.stream.application.service;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.stream.application.projection.RootProjection;
import com.summit.dp.stream.application.projection.StreamProjectionReducer;
import com.summit.dp.stream.application.projection.StreamRoundRegistry;
import com.summit.dp.stream.application.protocol.StreamEventEnvelope;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.protocol.StreamOperation;
import com.summit.dp.stream.application.protocol.StreamSnapshot;
import com.summit.dp.stream.infrastructure.transport.StreamSubscription;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** 每根串行推进投影，查询和网络均在门闩之外。 */
@Service
@Slf4j
public class SessionStreamHub {
    public static final int MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** 初始化等待有界，超出后必须重同步，不能跳过操作。 */
    private static final int MAX_PENDING_OPERATIONS = 2048;

    /** 心跳（ping）间隔与首次延迟，同为 30 秒：15 秒是常见反向代理空闲超时的一半，留足余量。 */
    private static final long HEARTBEAT_INITIAL_DELAY_SECONDS = 30;
    private static final long HEARTBEAT_PERIOD_SECONDS = 30;

/** 慢连接积压有界，避免挤占模型输出所需资源。 */
    public static final int SUBSCRIBER_QUEUE_CAPACITY = 256;

/** 空闲回收只适用于没有活跃执行和未决卡片的根会话。 */
    private static final long IDLE_ROOT_TTL_SECONDS = 600;

    /** v2 信封版本，与 v1 的 schemaVersion=1 区分；前端据此选择解析路径。 */
    private static final int SCHEMA_VERSION = 2;

/** 重同步期间仍累计正文，保证下一次快照能够恢复输出。 */
    private static final Set<String> MESSAGE_LIKE_TYPES = Set.of(
            StreamEventType.TEXT_DELTA.wireValue(),
            StreamEventType.THINKING_DELTA.wireValue(),
            StreamEventType.MESSAGE_FINALIZED.wireValue(),
            StreamEventType.MESSAGE_COMMITTED.wireValue());

    private static final String TEXT_DELTA_TYPE = StreamEventType.TEXT_DELTA.wireValue();
    private static final String THINKING_DELTA_TYPE = StreamEventType.THINKING_DELTA.wireValue();

    private final StreamSnapshotAssembler assembler;
    private final StreamProjectionReducer reducer;
    private final StreamRoundRegistry rounds;
    private final ObjectMapper json;
    private final StreamCalibrationOperations calibration;
    private final ObjectProvider<SseEventPublisher> legacy;
    private final Map<Long, RootState> roots = new ConcurrentHashMap<>();
    private final ExecutorService sender = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService maintenance = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "stream-maintenance"); thread.setDaemon(true); return thread;
    });

    public SessionStreamHub(StreamSnapshotAssembler assembler, StreamProjectionReducer reducer,
                            StreamRoundRegistry rounds, ObjectMapper json, ObjectProvider<SseEventPublisher> legacy) {
        this.assembler = assembler; this.reducer = reducer; this.rounds = rounds; this.json = json; this.legacy = legacy;
        this.calibration = new StreamCalibrationOperations(json);
        maintenance.scheduleWithFixedDelay(this::maintain, 30, 30, TimeUnit.SECONDS);
    }

    public void ensureInitialized(long rootId) {
        RootState state = roots.computeIfAbsent(rootId, key -> new RootState(key));
        boolean initialize;
        synchronized (state) {
            state.projection.lastTouched = Instant.now();
            initialize = !state.initializing && !state.initialized.isDone();
            if (initialize) state.initializing = true;
        }
        if (initialize) {
            try {
                StreamSnapshotAssembler.Base base = assembler.load(rootId);
                synchronized (state) {
                    installBase(state, base);
                    while (!state.pending.isEmpty()) apply(state, state.pending.remove());
                    state.initialized.complete(null);
                }
            } catch (RuntimeException error) {
                state.initialized.completeExceptionally(error);
                roots.remove(rootId, state);
                throw error;
            }
        }
        state.initialized.join();
    }

    /** 快照与注册共享一个串行边界，首帧不会被后续 delta 超越。 */
    public SseEmitter subscribe(long rootId) {
        ensureInitialized(rootId);
        RootState state = roots.get(rootId);
        StreamSnapshotAssembler.Base base = assembler.load(rootId);
        SseEmitter emitter = newEmitter();
        synchronized (state) {
            installBase(state, base);
            throwIf(state.unavailable, "实时投影不可用，请重新同步状态");
            StreamSnapshot snapshot = state.projection.snapshot();
            JsonNode payload = json.valueToTree(snapshot);
            throwIf(payload.toString().getBytes(StandardCharsets.UTF_8).length > MAX_SNAPSHOT_BYTES,
                    "当前输出过大，无法建立完整快照，请等待执行收尾后重试");
            StreamSubscription subscription = new StreamSubscription(emitter, sender, SUBSCRIBER_QUEUE_CAPACITY,
                    () -> state.subscribers.remove(emitter));
            StreamEventEnvelope frame = new StreamEventEnvelope(SCHEMA_VERSION, String.valueOf(IdUtil.getSnowflakeNextId()),
                    state.projection.epoch, snapshot.watermark(), String.valueOf(rootId), String.valueOf(rootId),
                    null, null, snapshot.historyRevision(), StreamEventType.STREAM_SNAPSHOT.wireValue(),
                    Instant.now(), payload);
            state.subscribers.put(emitter, subscription);
            if (!subscription.offer(SseEmitter.event().name(frame.type()).id(frame.eventId()).data(frame))) {
                state.subscribers.remove(emitter);
            }
            state.projection.lastTouched = Instant.now();
        }
        return emitter;
    }

    public StreamSnapshot snapshot(long rootId) {
        ensureInitialized(rootId);
        RootState state = roots.get(rootId);
        StreamSnapshotAssembler.Base base = assembler.load(rootId);
        synchronized (state) { installBase(state, base); return state.projection.snapshot(); }
    }

    public void publish(long rootId, StreamOperation operation) {
        RootState state = roots.computeIfAbsent(rootId, RootState::new);
        boolean initialized;
        synchronized (state) {
            initialized = state.initialized.isDone();
            if (!initialized) {
                throwIf(state.pending.size() >= MAX_PENDING_OPERATIONS, "投影初始化队列已满，请重新同步状态");
                state.pending.add(operation);
            } else apply(state, operation);
        }
        if (!initialized) ensureInitialized(rootId);
    }

    /** v1 载荷仅在入口转换，v2 客户端不会收到原始框架 JSON。 */
    public void publishLegacy(long rootId, String serialized) {
        try {
            ensureInitialized(rootId);
            RootState state = roots.get(rootId);
            JsonNode event = json.readTree(serialized);
            String type = event.path("type").asText();
            String executionId = event.path("executionId").asText(null);
            String sessionId = event.path("sessionId").asText(String.valueOf(rootId));
            synchronized (state) {
                if (executionId != null) {
                    Source identity = state.sources.computeIfAbsent(executionId, ignored -> new Source(
                            sessionId, event.path("turnId").asText(null), String.valueOf(state.projection.historyRevision)));
                    if (!state.projection.invalidExecutions.contains(executionId)
                            && Long.parseLong(identity.revision()) == state.projection.historyRevision) {
                        for (StreamOperation operation : rounds.accept(identity.sessionId(), identity.turnId(), identity.revision(), event)) apply(state, operation);
                        if (type.startsWith(StreamEventType.EXECUTION_LIFECYCLE_PREFIX)
                                || StreamEventType.CONTEXT_UPDATE.wireValue().equals(type)) {
                            ObjectNode payload = json.createObjectNode();
                            if (StreamEventType.CONTEXT_UPDATE.wireValue().equals(type)) {
                                for (String key : List.of("phase", "tokenCount", "maxTokens", "ratio", "usage", "metric", "beforeTokenCount", "afterTokenCount")) {
                                    if (event.has(key)) payload.set(key, event.get(key).deepCopy());
                                }
                            } else {
                                payload.put("state", type.substring(StreamEventType.EXECUTION_LIFECYCLE_PREFIX.length()));
                                for (String key : List.of("reason", "errorMessage", "message")) if (event.has(key)) payload.set(key, event.get(key).deepCopy());
                            }
                            payload.put("identityUnknown", identity.turnId() == null);
                            apply(state, StreamOperation.create(identity.sessionId(), identity.turnId(), executionId,
                                    identity.revision(), type, payload));
                        }
                    }
                }
            }
        } catch (Exception error) {
            RootState state = roots.get(rootId);
            if (state != null) synchronized (state) {
                state.unavailable = true;
                state.subscribers.values().forEach(subscription -> sender.execute(subscription::abort));
            }
            log.error("转换流事件失败: rootSessionId={}", rootId, error);
        }
        legacy.getObject().publishV1(rootId, serialized);
    }

    public String currentRevision(long rootId) {
        ensureInitialized(rootId);
        RootState state = roots.get(rootId);
        synchronized (state) { return String.valueOf(state.projection.historyRevision); }
    }

    private void installBase(RootState state, StreamSnapshotAssembler.Base base) {
        RootProjection root = state.projection;
        if (base.revision() < root.historyRevision) return;
        boolean reconcile = state.initialized.isDone();
        if (state.unavailable) {
            RootProjection recovered = new RootProjection(Long.parseLong(root.rootSessionId));
            recovered.historyRevision = base.revision();
            recovered.invalidTurns.addAll(root.invalidTurns);
            recovered.invalidExecutions.addAll(root.invalidExecutions);
            if (base.revision() == root.historyRevision) root.messages.forEach((key, value) -> {
                if (!value.path("committed").asBoolean()) recovered.messages.put(key, value.deepCopy());
            });
            state.projection = recovered;
            root = recovered;
            state.unavailable = false;
            reconcile = false;
        }
        if (base.revision() > root.historyRevision) {
            if (reconcile) {
                ObjectNode payload = json.createObjectNode().put("historyRevision", String.valueOf(base.revision())).put("clearHistory", true);
                rounds.invalidate(state.sources.keySet());
                apply(state, StreamOperation.create(root.rootSessionId, null, null, null, "HISTORY_INVALIDATED", payload));
            } else root.historyRevision = base.revision();
        }
        if (reconcile) {
            calibration.build(Long.parseLong(root.rootSessionId), base).forEach(operation -> apply(state, operation));
            return;
        }
        for (ObjectNode value : base.sessions()) reducer.merge(root.sessions, value, "id", false);
        for (ObjectNode value : base.turns()) reducer.merge(root.turns, value, "turnId", false);
        for (ObjectNode value : base.executions()) reducer.merge(root.executions, value, "id", false);
        for (ObjectNode value : base.tools()) reducer.merge(root.tools, value, "id", true);
        for (ObjectNode value : base.messages()) {
            String key = value.path("streamKey").asText();
            ObjectNode current = root.messages.get(key);
            if (current == null) root.messages.put(key, value.deepCopy());
            else {
                ObjectNode canonical = value.deepCopy();
                if (current.hasNonNull("executionId")) canonical.set("executionId", current.get("executionId"));
                root.messages.put(key, canonical);
            }
        }
        stampTools(root);
        retain(root);
    }

    private void apply(RootState state, StreamOperation operation) {
        if (state.unavailable) {
            if (List.of(StreamEventType.TEXT_DELTA.wireValue(), StreamEventType.THINKING_DELTA.wireValue(),
                    StreamEventType.MESSAGE_FINALIZED.wireValue(), StreamEventType.MESSAGE_COMMITTED.wireValue()).contains(operation.type())) {
                reducer.apply(state.projection, operation);
            }
            return;
        }
        try { if (!reducer.apply(state.projection, operation)) return; }
        catch (IllegalStateException error) {
            state.unavailable = true;
            state.subscribers.values().forEach(subscription -> sender.execute(subscription::abort));
            throw error;
        }
        RootProjection root = state.projection;
        root.seq++;
        root.lastTouched = Instant.now();
        if (StreamEventType.HISTORY_INVALIDATED.wireValue().equals(operation.type())) rounds.invalidate(root.invalidExecutions);
        stampTools(root);
        retain(root);
        if (root.messages.values().stream().mapToLong(value -> value.path("text").asText("").length()
                + value.path("thinking").asText("").length()).sum() > MAX_SNAPSHOT_BYTES * 2L
                || root.sessions.size() + root.turns.size() + root.executions.size() + root.messages.size() + root.tools.size() > 10000
                || root.invalidTurns.size() + root.invalidExecutions.size() > 10000) {
            state.unavailable = true;
            for (StreamSubscription subscription : state.subscribers.values()) {
                sender.execute(subscription::abort);
            }
            return;
        }
        JsonNode payload = operation.payload().deepCopy();
        if (StreamEventType.TEXT_DELTA.wireValue().equals(operation.type()) || StreamEventType.THINKING_DELTA.wireValue().equals(operation.type())) {
            ObjectNode delta = (ObjectNode) payload;
            JsonNode message = delta.remove("message");
            for (String key : List.of("streamKey", "blockVersion", "purpose")) delta.set(key, message.path(key));
        } else if (StreamEventType.MESSAGE_COMMITTED.wireValue().equals(operation.type())) {
            ((ObjectNode) payload).set("message", root.messages.get(payload.path("message").path("streamKey").asText()).deepCopy());
        }
        if (StreamEventType.TOOL_CALL_UPDATED.wireValue().equals(operation.type())) {
            String id = payload.path("toolCall").path("id").asText();
            ((ObjectNode) payload).set("toolCall", root.tools.get(id).deepCopy());
        }
        StreamEventEnvelope envelope = new StreamEventEnvelope(SCHEMA_VERSION, operation.eventId(), root.epoch,
                String.valueOf(root.seq), root.rootSessionId, operation.sessionId(), operation.turnId(),
                operation.executionId(), String.valueOf(root.historyRevision), operation.type(), Instant.now(), payload);
        for (StreamSubscription subscription : state.subscribers.values()) {
            subscription.offer(SseEmitter.event().name(envelope.type()).id(envelope.eventId()).data(envelope));
        }
    }

    private void stampTools(RootProjection root) {
        for (ObjectNode tool : root.tools.values()) {
            tool.put("projectionStamp", root.epoch + ":" + root.seq);
            ObjectNode execution = root.executions.get(tool.path("executionId").asText());
            if (execution != null) {
                tool.set("executionVersion", execution.path("version"));
                if (execution.path("status").asInt(-1) != 2) {
                    tool.putArray("allowedActions");
                    if (!tool.path("status").asText().equals("completed")) tool.put("unavailableReason", "执行当前不可接受决策");
                }
            }
        }
    }

    private void retain(RootProjection root) {
        List<String> completed = root.turns.entrySet().stream()
                .filter(entry -> List.of("COMPLETED", "FAILED", "CANCELLED").contains(entry.getValue().path("status").asText()))
                .map(Map.Entry::getKey).sorted(Comparator.comparingLong((String value) -> Long.parseLong(value)).reversed()).toList();
        if (completed.size() <= StreamSnapshotAssembler.RETAINED_COMPLETED_TURNS) return;
        Set<String> discarded = new HashSet<>(completed.subList(StreamSnapshotAssembler.RETAINED_COMPLETED_TURNS, completed.size()));
        discarded.removeIf(id -> {
            ObjectNode execution = root.executions.get(root.turns.get(id).path("executionId").asText());
            return execution != null && execution.path("status").asInt(3) < 3;
        });
        Set<String> discardedExecutions = new HashSet<>();
        discarded.forEach(id -> {
            ObjectNode turn = root.turns.remove(id);
            if (turn.hasNonNull("executionId")) discardedExecutions.add(turn.path("executionId").asText());
        });
        root.messages.values().removeIf(message -> discarded.contains(message.path("turnId").asText()));
        root.tools.values().removeIf(tool -> discardedExecutions.contains(tool.path("executionId").asText()) && !tool.path("pending").asBoolean());
        discardedExecutions.forEach(root.executions::remove);
        rounds.invalidate(discardedExecutions);
        RootState state = roots.get(Long.parseLong(root.rootSessionId));
        if (state != null) discardedExecutions.forEach(state.sources::remove);
    }

    private void maintain() {
        roots.forEach((id, state) -> {
            synchronized (state) {
                state.subscribers.values().forEach(subscription -> subscription.offer(SseEmitter.event().comment("ping")));
                if (state.initialized.isDone() && state.subscribers.isEmpty() && !state.projection.hasUnfinishedWork()
                        && state.projection.lastTouched.isBefore(Instant.now().minusSeconds(IDLE_ROOT_TTL_SECONDS))) {
                    if (roots.remove(id, state)) rounds.invalidate(state.sources.keySet());
                }
            }
        });
    }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
    protected SseEmitter newEmitter() { return new SseEmitter(0L); }
    @PreDestroy public void close() {
        maintenance.shutdownNow();
        roots.values().forEach(state -> state.subscribers.values().forEach(StreamSubscription::close));
        sender.shutdownNow();
    }
    private record Source(String sessionId, String turnId, String revision) { }
    private static final class RootState {
        private RootProjection projection;
        private final CompletableFuture<Void> initialized = new CompletableFuture<>();
        private boolean initializing;
        private boolean unavailable;
        private final Queue<StreamOperation> pending = new ArrayDeque<>();
        private final Map<String, Source> sources = new HashMap<>();
        private final Map<SseEmitter, StreamSubscription> subscribers = new ConcurrentHashMap<>();
        private RootState(long rootId) { projection = new RootProjection(rootId); }
    }
}

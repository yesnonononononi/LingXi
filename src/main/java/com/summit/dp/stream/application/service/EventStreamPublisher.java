package com.summit.dp.stream.application.service;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.infrastructure.transport.StreamSubscription;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * v3 直投发布器：只做「根连接注册 + 类型化直投 + 心跳/断开」。
 *
 * <p><b>为什么不初始化投影</b>：v3 协议不维护历史累积投影，也不提供逐事件回放。发布器<b>不加载
 * 历史、不组装快照</b>，一条事件只做「读身份 → 构造信封 → 序列化一次 → 按连接 FIFO 入队」。
 * 前端收到 {@code STREAM_READY} 后再自行发一次 bootstrap 查询拿持久化状态（§8）。</p>
 *
 * <p><b>事件 ID 只生成一次</b>：{@code eventId} 在发布入口创建，随不可变帧广播给该根会话的每条
 * 连接；绝不每连接各生成一个。帧 JSON 在编码时一次性得到、各连接共享，不对每条连接重复
 * {@code toString/getBytes}（§5）。</p>
 *
 * <p><b>队列上限复用既有限制</b>：直接使用 {@link StreamSubscription} 的「条数 + 字节数」双重上限，
 * 不另写单上限队列 —— 溢出行为（清空并断开，触发前端重连同步）由它统一保证。</p>
 */
@Slf4j
@Component
public class EventStreamPublisher {

    private static final long HEARTBEAT_INTERVAL_SECONDS = 30;

    /** 订阅注册表：rootSessionId → 该根会话（含其全部子会话）的所有活跃连接。 */
    private final Map<Long, Set<SseEmitter>> emittersByRootSession = new ConcurrentHashMap<>();
    private final Map<SseEmitter, StreamSubscription> queues = new ConcurrentHashMap<>();
    private final ObjectMapper json;
    private final ExecutorService sender = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService heartbeatScheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread thread = new Thread(r, "v3-sse-heartbeat");
                thread.setDaemon(true);
                return thread;
            });

    public EventStreamPublisher(ObjectMapper json) {
        this.json = json;
        heartbeatScheduler.scheduleWithFixedDelay(this::heartbeat,
                HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    @PreDestroy
    public void close() {
        heartbeatScheduler.shutdownNow();
        queues.values().forEach(StreamSubscription::close);
        sender.shutdownNow();
    }

    /**
     * 登记一条 v3 连接并立即排入 {@code STREAM_READY}。
     *
     * <p><b>不查业务库</b>：只登记连接、发一帧控制帧，业务状态由前端收到 READY 后走 bootstrap 拉取。</p>
     *
     * @param rootSessionId 根会话 ID；子会话事件也路由到该键
     * @return 写向浏览器的 emitter
     */
    public SseEmitter subscribe(long rootSessionId) {
        SseEmitter emitter = newEmitter();
        StreamSubscription subscription = new StreamSubscription(emitter, sender,
                SessionStreamHub.SUBSCRIBER_QUEUE_CAPACITY, () -> remove(rootSessionId, emitter), false);
        queues.put(emitter, subscription);
        Set<SseEmitter> bucket = emittersByRootSession.computeIfAbsent(rootSessionId,
                key -> new CopyOnWriteArraySet<>());
        bucket.add(emitter);

        emitter.onCompletion(() -> remove(rootSessionId, emitter));
        emitter.onTimeout(() -> {
            remove(rootSessionId, emitter);
            emitter.complete();
        });
        emitter.onError(error -> remove(rootSessionId, emitter));

        // 首帧只声明连接就绪与连接代次；无任何业务状态，不查库。
        subscription.offer(controlFrame(StreamV3EventType.STREAM_READY, new StreamV3Payloads.Ready(
                String.valueOf(IdUtil.getSnowflakeNextId()), StreamV3EventType.SCHEMA_VERSION)));
        log.info("建立 v3 流连接: rootSessionId={}, total={}", rootSessionId, connectedCount());
        return emitter;
    }

    /**
     * 定向直投：只发给订阅了 {@code rootSessionId} 的连接。
     *
     * <p>帧 JSON <b>只序列化一次</b>，各连接共享同一份数据；无活跃订阅时直接跳过，不做任何工作。</p>
     */
    public void publish(long rootSessionId, StreamV3Event event) {
        Set<SseEmitter> bucket = emittersByRootSession.get(rootSessionId);
        if (bucket == null || bucket.isEmpty()) {
            return;
        }
        String body;
        try {
            body = json.writeValueAsString(event);
        } catch (JsonProcessingException error) {
            log.error("v3 事件序列化失败: type={}, error={}", event.type(), error.toString());
            return;
        }
        // SSE 的 event: 名与帧内 type 取同一个量：event.type() 已是 wireValue 口径
        // （StreamV3Event.of 内部用 type.wireValue() 落值），两侧不会再分叉（§8.3）。
        for (SseEmitter emitter : bucket) {
            StreamSubscription subscription = queues.get(emitter);
            if (subscription != null) {
                subscription.offer(SseEmitter.event().name(event.type()).data(body));
            }
        }
    }

    public void finish(SseEmitter emitter) {
        StreamSubscription subscription = queues.get(emitter);
        if (subscription != null) {
            subscription.finish();
        } else {
            emitter.complete();
        }
    }

    /** 构造控制帧（如 STREAM_READY）：身份全空、载荷无业务状态。 */
    private SseEmitter.SseEventBuilder controlFrame(StreamV3EventType type, Object data) {
        try {
            String body = json.writeValueAsString(StreamV3Event.of(String.valueOf(IdUtil.getSnowflakeNextId()),
                    new StreamV3Event.Identity(null, null, null, null, null, null), type, Instant.now(), data));
            return SseEmitter.event().name(type.wireValue()).data(body);
        } catch (JsonProcessingException error) {
            log.error("v3 控制帧序列化失败: type={}, error={}", type.wireValue(), error.toString());
            return SseEmitter.event().comment("ping");
        }
    }

    /** 原子「移除 emitter + 回收空桶」；幂等。 */
    private void remove(long rootSessionId, SseEmitter emitter) {
        StreamSubscription subscription = queues.remove(emitter);
        if (subscription != null) {
            subscription.close();
        }
        emittersByRootSession.compute(rootSessionId, (key, existing) -> {
            if (existing == null) {
                return null;
            }
            existing.remove(emitter);
            return existing.isEmpty() ? null : existing;
        });
    }

    /** 保活注释行，跨反向代理维持空闲连接。 */
    private void heartbeat() {
        for (Set<SseEmitter> bucket : emittersByRootSession.values()) {
            for (SseEmitter emitter : bucket) {
                StreamSubscription subscription = queues.get(emitter);
                if (subscription != null) {
                    subscription.offer(SseEmitter.event().comment("ping"));
                }
            }
        }
    }

    /** 创建 emitter；独立成工厂方法便于单测注入 mock。永不超时（依赖心跳 + 断开回调）。 */
    protected SseEmitter newEmitter() {
        return new SseEmitter(0L);
    }

    /** 当前活跃连接总数。 */
    public int connectedCount() {
        return emittersByRootSession.values().stream().mapToInt(Set::size).sum();
    }
}

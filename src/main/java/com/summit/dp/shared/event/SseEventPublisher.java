package com.summit.dp.shared.event;

import lombok.extern.slf4j.Slf4j;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import com.summit.dp.stream.application.service.SessionStreamHub;
import com.summit.dp.stream.infrastructure.transport.StreamSubscription;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;

/** v1 仅负责兼容传输，业务发布统一先进入根会话投影。 */
@Slf4j
@Component
public class SseEventPublisher {

    private static final long HEARTBEAT_INTERVAL_SECONDS = 30;

    /** 订阅注册表：rootSessionId → 该根会话（含其全部子会话）的所有活跃流。 */
    private final Map<Long, Set<SseEmitter>> emittersByRootSession = new ConcurrentHashMap<>();
    private final Map<SseEmitter, StreamSubscription> queues = new ConcurrentHashMap<>();
    private final ExecutorService sender = Executors.newVirtualThreadPerTaskExecutor();
    @Autowired(required = false)
    private ObjectProvider<SessionStreamHub> hub;
    private final ScheduledExecutorService heartbeatScheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "sse-heartbeat");
                t.setDaemon(true);
                return t;
            });

    public SseEventPublisher() {
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
     * 建立事件流，订阅到指定的根会话。
     *
     * <p>调用方必须先解析出确定的会话身份（HC-2：prepare 之后再建流）；
     * 入参为 primitive {@code long}，身份缺失在编译期就不可能通过。</p>
     *
     * @param rootSessionId 根会话 ID；根会话自身的订阅与子会话事件都路由到该键
     * @return the emitter to write to
     */
    public SseEmitter connect(long rootSessionId) {
        SseEmitter emitter = newEmitter();
        queues.put(emitter, new StreamSubscription(emitter, sender, SessionStreamHub.SUBSCRIBER_QUEUE_CAPACITY,
                () -> remove(rootSessionId, emitter), false));
        Set<SseEmitter> bucket = emittersByRootSession.computeIfAbsent(rootSessionId,
                key -> new CopyOnWriteArraySet<>());
        bucket.add(emitter);

        emitter.onCompletion(() -> {
            remove(rootSessionId, emitter);
            log.info("结束流连接: rootSessionId={}, total={}", rootSessionId, connectedCount());
        });
        emitter.onTimeout(() -> {
            remove(rootSessionId, emitter);
            log.info("流连接超时: rootSessionId={}, total={}", rootSessionId, connectedCount());
            emitter.complete();
        });
        emitter.onError(e -> {
            remove(rootSessionId, emitter);
            log.warn("流连接异常: rootSessionId={}, error={}", rootSessionId, e.getMessage());
        });
        log.info("建立流连接: rootSessionId={}, total={}", rootSessionId, connectedCount());
        return emitter;
    }

    /**
     * 定向推送：只发给订阅了 {@code rootSessionId} 的流。
     *
     * <p>子执行事件归入父任务：子会话的事件必须用 rootSessionId 推送。
     * 没有活跃订阅时静默忽略（前端可能尚未建流，或已切走待回查历史）。</p>
     */
    public void publish(long rootSessionId, String payload) {
        SessionStreamHub stream = hub == null ? null : hub.getIfAvailable();
        if (stream == null) publishV1(rootSessionId, payload);
        else stream.publishLegacy(rootSessionId, payload);
    }

    public void prepareProjection(long rootSessionId) {
        SessionStreamHub stream = hub == null ? null : hub.getIfAvailable();
        if (stream != null) stream.ensureInitialized(rootSessionId);
    }

    public void finish(SseEmitter emitter) {
        StreamSubscription subscription = queues.get(emitter);
        if (subscription != null) subscription.finish();
        else emitter.complete();
    }

    /** 兼容传输入口仅供 hub 调用，业务事件不能绕过投影。 */
    public void publishV1(long rootSessionId, String payload) {
        Set<SseEmitter> bucket = emittersByRootSession.get(rootSessionId);
        if (bucket == null || bucket.isEmpty()) {
            return;
        }
        for (SseEmitter emitter : bucket) {
            send(rootSessionId, emitter, payload);
        }
    }

    /**
     * 写出单条事件；写不出去就降级为 DEBUG 并摘掉该流。
     *
     * <p><b>为什么写失败不是告警。</b>SSE 是尽力而为的推送通道，不是可靠投递。执行终态事件
     * （complete / cancel / error）先于 {@code RuntimeProcessorTemplate#clear} 的收尾用量推送发出，
     * 前端看到终态就会关流，于是「终态之后那一条用量推送写不出去」是<b>每轮都会发生</b>的正常现象。
     * 它此前被 {@code catch (IOException)} 打成 WARN 并附完整堆栈 —— {@code AsyncRequestNotUsableException}
     * 正是继承 IOException 的，所以每轮都刷一条假告警。</p>
     *
     * <p><b>为什么还要摘掉而不是只忽略。</b>客户端断开后容器未必立刻回调 onError，继续对它写入
     * 只会重复失败。会话状态另有快照兜底，丢一条推送不影响正确性。</p>
     */
    private void send(long rootSessionId, SseEmitter emitter, String payload) {
        StreamSubscription subscription = queues.get(emitter);
        if (subscription != null) subscription.offer(SseEmitter.event().name("message").data(payload));
    }

    /** 断开原因摘要：只取最内层 cause 的类名与消息，避免把整条堆栈写进日志。 */
    private static String causeSummary(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getClass().getSimpleName() + ": " + root.getMessage();
    }

    /**
     * 原子「移除 emitter + 回收空桶」：仅当桶空时才删 key，避免把仍有活跃流的桶
     * 连带删掉（后续 publish 会静默丢事件）；compute 按键加锁，同时关掉
     * 「断开回调与并发 connect 之间误删新桶」的竞态。幂等：重复调用无害。
     */
    private void remove(long rootSessionId, SseEmitter emitter) {
        StreamSubscription subscription = queues.remove(emitter);
        if (subscription != null) subscription.close();
        emittersByRootSession.compute(rootSessionId, (key, existing) -> {
            if (existing == null) {
                return null; // 桶已被回收，本次移除无事可做。
            }
            existing.remove(emitter);
            return existing.isEmpty() ? null : existing;
        });
    }

    /** Sends a comment line to keep idle connections alive across proxies. */
    private void heartbeat() {
        for (Set<SseEmitter> bucket : emittersByRootSession.values()) {
            for (SseEmitter emitter : bucket) {
                StreamSubscription subscription = queues.get(emitter);
                if (subscription != null) subscription.offer(SseEmitter.event().comment("ping"));
            }
        }
    }

    /**
     * 创建 emitter；独立成工厂方法便于单测注入 mock，验证回调注册与移除时序。
     * 永不超时（存活依赖 heartbeat + 客户端断开回调）。
     */
    protected SseEmitter newEmitter() {
        return new SseEmitter(0L);
    }

    /** 当前活跃连接总数，用于可观测性。 */
    public int connectedCount() {
        return emittersByRootSession.values().stream().mapToInt(Set::size).sum();
    }

    /** 当前有活跃订阅的根会话数量，用于可观测性（「按用户计数」的语义已随 HC-1 消失）。 */
    public int connectedRootCount() {
        return emittersByRootSession.size();
    }
}

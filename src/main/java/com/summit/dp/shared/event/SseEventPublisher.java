package com.summit.dp.shared.event;

import lombok.extern.slf4j.Slf4j;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Server-Sent Events publisher that keeps connected front-end event streams
 * alive and pushes agent runtime events to them in real-time.
 *
 * <p>Drop-in replacement for the WebSocket channel: the JSON envelope
 * ({@code type / executionId / timestamp / data}) is unchanged, only the
 * transport differs.</p>
 *
 * <p>本地模式：事件只推送给当前进程持有的 emitter，不经过任何跨节点通道。</p>
 *
 * <p><b>按根会话路由（HC-3 终态）：</b>连接按 rootSessionId 归档，推送必须显式给出
 * 目标根会话。全局广播方法已<b>物理删除</b> —— 无法确定归属的事件会被丢弃并告警，
 * 不存在「发不出去就发给所有人」的退路；编译器同时兜底：新的调用不可能再出现
 * 无目标的广播。</p>
 *
 * <p>子执行事件归入父任务：子会话的事件必须用 <b>rootSessionId</b> 推送，
 * 因为前端只为根会话建流（子代理产生的 runtime 事件由前端按 sessionId 渲染）。</p>
 */
@Slf4j
@Component
public class SseEventPublisher {

    private static final long HEARTBEAT_INTERVAL_SECONDS = 30;

    /** 订阅注册表：rootSessionId → 该根会话（含其全部子会话）的所有活跃流。 */
    private final Map<Long, Set<SseEmitter>> emittersByRootSession = new ConcurrentHashMap<>();
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
        Set<SseEmitter> bucket = emittersByRootSession.computeIfAbsent(rootSessionId,
                key -> new CopyOnWriteArraySet<>());
        bucket.add(emitter);

        Runnable remove = () ->
                // 原子「移除 emitter + 回收空桶」：仅当桶空时才删 key，避免把仍有活跃流的桶
                // 连带删掉（后续 publish 会静默丢事件）；compute 按键加锁，同时关掉
                // 「断开回调与并发 connect 之间误删新桶」的竞态。
                emittersByRootSession.compute(rootSessionId, (key, existing) -> {
                    if (existing == null) {
                        return null; // 桶已被回收，本次移除无事可做。
                    }
                    existing.remove(emitter);
                    return existing.isEmpty() ? null : existing;
                });
        emitter.onCompletion(() -> {
            remove.run();
            log.info("SSE connection completed, rootSession={}, total={}", rootSessionId, connectedCount());
        });
        emitter.onTimeout(() -> {
            remove.run();
            log.info("SSE connection timed out, rootSession={}, total={}", rootSessionId, connectedCount());
            emitter.complete();
        });
        emitter.onError(e -> {
            remove.run();
            log.warn("SSE connection error, rootSession={}, error={}", rootSessionId, e.getMessage());
        });
        log.info("SSE connected, rootSession={}, total={}", rootSessionId, connectedCount());
        return emitter;
    }

    /**
     * 定向推送：只发给订阅了 {@code rootSessionId} 的流。
     *
     * <p>子执行事件归入父任务：子会话的事件必须用 rootSessionId 推送。
     * 没有活跃订阅时静默忽略（前端可能尚未建流，事件已有会话内快照兜底）。</p>
     */
    public void publish(long rootSessionId, String payload) {
        Set<SseEmitter> bucket = emittersByRootSession.get(rootSessionId);
        if (bucket == null || bucket.isEmpty()) {
            return;
        }
        for (SseEmitter emitter : bucket) {
            send(emitter, payload);
        }
    }

    private void send(SseEmitter emitter, String payload) {
        try {
            emitter.send(SseEmitter.event().name("message").data(payload));
        } catch (IOException | IllegalStateException e) {
            log.warn("Failed to send SSE event", e);
            // 不再尝试对已断开的输出流写数据。onError/onCompletion 会做幂等移除。
        }
    }

    /** Sends a comment line to keep idle connections alive across proxies. */
    private void heartbeat() {
        for (Set<SseEmitter> bucket : emittersByRootSession.values()) {
            for (SseEmitter emitter : bucket) {
                try {
                    emitter.send(SseEmitter.event().comment("ping"));
                } catch (IOException | IllegalStateException e) {
                    // 断开连接由 onError/onCompletion 兜底移除，这里只跳过。
                }
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

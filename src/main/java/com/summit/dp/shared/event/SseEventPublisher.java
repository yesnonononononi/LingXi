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
 *
 * <h2>流是会话级的，不是请求级的</h2>
 *
 * <p>推送通道只做一件事：把事件投递给<b>当前连着</b>的流。没有订阅者时事件即丢弃 ——
 * 这是刻意的：SSE 是实时通道，不是可靠投递，也不承担补历史的责任。前端切走再切回时
 * 由它自己回查会话历史（{@code session} 接口）对齐状态，然后重新挂载本流接收后续事件。
 * 服务端因此不需要事件日志、序号与缺口回放 —— 那些是「通道负责一致性」的另一套设计，
 * 与「历史接口负责一致性」重复且更容易腐坏。</p>
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

        emitter.onCompletion(() -> {
            remove(rootSessionId, emitter);
            log.info("SSE connection completed, rootSession={}, total={}", rootSessionId, connectedCount());
        });
        emitter.onTimeout(() -> {
            remove(rootSessionId, emitter);
            log.info("SSE connection timed out, rootSession={}, total={}", rootSessionId, connectedCount());
            emitter.complete();
        });
        emitter.onError(e -> {
            remove(rootSessionId, emitter);
            log.warn("SSE connection error, rootSession={}, error={}", rootSessionId, e.getMessage());
        });
        log.info("SSE connected, rootSession={}, total={}", rootSessionId, connectedCount());
        return emitter;
    }

    /**
     * 定向推送：只发给订阅了 {@code rootSessionId} 的流。
     *
     * <p>子执行事件归入父任务：子会话的事件必须用 rootSessionId 推送。
     * 没有活跃订阅时静默忽略（前端可能尚未建流，或已切走待回查历史）。</p>
     */
    public void publish(long rootSessionId, String payload) {
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
        try {
            emitter.send(SseEmitter.event().name("message").data(payload));
        } catch (IOException | IllegalStateException e) {
            log.debug("SSE stream no longer writable, subscription dropped: rootSession={}, cause={}",
                    rootSessionId, causeSummary(e));
            remove(rootSessionId, emitter);
        }
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

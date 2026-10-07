package com.summit.dp.shared.event;

import com.summit.core.conversation.event.AgentEvent;
import lombok.extern.slf4j.Slf4j;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * SSE 事件传输：按根会话归档活跃连接，业务事件定向推送给该根会话的全部流。
 *
 * <p>投影与协议渲染已整体移除；本类只承担「连接注册 + 就绪握手 + 尽力投递 + 心跳保活」，
 * 不含任何事件语义。</p>
 *
 * <p><b>流为什么不需要「执行终结即关流」来兜底</b>（这结论决定了本类的边界）：
 * 摘流有四个触发点，<b>没有一个是业务事件</b>——
 * {@code connect} 注册的 {@code onCompletion} / {@code onTimeout} / {@code onError}，
 * 以及 {@link #send} / {@link #sendSignal} 的写失败分支。其中<b>心跳本身就是死连接探测器</b>：
 * 每 {@value #HEARTBEAT_INTERVAL_SECONDS} 秒写一帧，写不出去立刻摘流。所以即便客户端静默消失、
 * 容器三个回调一个都不触发，也会在一个心跳周期内被摘掉，不会无限期滞留。
 * 既然如此，按业务语义去关流（完成 / 失败 / 停止）就只剩副作用：它会在前端下一次发送之前
 * 制造一段没有订阅者的空窗期，因此不这么做。流的存亡交给前端页面的挂载 / 卸载。</p>
 */
@Slf4j
@Component
public class SseEventPublisher {

    private static final long HEARTBEAT_INTERVAL_SECONDS = 30;

    /**
     * 传输层信号事件名（就绪 / 心跳）。
     *
     * <p>这些是传输层语义，不是框架 {@code AgentEvent}：不进入 {@link #publish(long, AgentEvent)}
     * 的业务事件通道；抽成枚举避免字面量散落。</p>
     */
    private enum SignalEvent {
        READY,
        HEARTBEAT
    }

    /** 订阅注册表：rootSessionId → 该根会话（含其全部子会话）的所有活跃流。 */
    private final Map<Long, Set<SseEmitter>> emittersByRootSession = new ConcurrentHashMap<>();
    private final ExecutorService sender = Executors.newVirtualThreadPerTaskExecutor();
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
        sender.shutdownNow();
    }

    /**
     * 建立事件流，订阅到指定的根会话。
     *
     * <p>调用方必须先解析出确定的会话身份；入参为 primitive {@code long}，
     * 身份缺失在编译期就不可能通过。</p>
     *
     * <p><b>顺序不可反</b>：必须先把 emitter 注册进桶，再发出 {@code READY}。客户端收到
     * READY 即代表本 emitter 已在桶里，「等 READY 再提交发送」的正确性完全建立在这个顺序上；
     * 反过来发则存在「已收到就绪、事件却还投不进来」的窗口。</p>
     *
     * @param rootSessionId 根会话 ID；根会话自身的订阅与子会话事件都路由到该键
     * @return the emitter to write to
     */
    public SseEmitter connect(long rootSessionId) {
        SseEmitter emitter = newEmitter();
        Set<SseEmitter> bucket = emittersByRootSession.computeIfAbsent(rootSessionId,
                key -> new CopyOnWriteArraySet<>());
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
        // 注册之后立即发就绪帧：客户端据此判定「可以提交发送」。rootSessionId 是雪花 ID，
        // 转成字符串下发，避免前端 JS 精度截断。
        bucket.add(emitter);
        sendSignal(rootSessionId, emitter, SignalEvent.READY, Map.of("rootSessionId", Long.toString(rootSessionId)));
        log.info("建立流连接: rootSessionId={}, total={}", rootSessionId, connectedCount());
        return emitter;
    }

    /**
     * 定向推送：只发给订阅了 {@code rootSessionId} 的流。
     *
     * <p>子执行事件归入父任务：子会话的事件必须用 rootSessionId 推送。
     * 没有活跃订阅时静默忽略（前端可能尚未建流，或已切走待回查历史）。</p>
     */
    public void publish(long rootSessionId, AgentEvent event) {

        Set<SseEmitter> bucket = emittersByRootSession.get(rootSessionId);

        if (bucket == null || bucket.isEmpty()) {
            return;
        }
        for (SseEmitter emitter : bucket) {
            send(rootSessionId, emitter, event);
        }
    }

    /**
     * 结束一条流的写入：常规结束走 complete，让容器按 SSE 协议收尾。
     *
     * <p>只用于<b>一次性短命流</b> —— 调用方自己 connect 出来、只承载一次动作（命令审批、
     * 审批后恢复），因此必须在 {@code finally} 里显式收尾，否则浏览器停止读取后
     * 后端仍会保留失效emitter。</p>
     *
     * <p>会话级订阅流不走这里：它的存亡跟页面挂载 / 卸载走，执行完成 / 失败 / 停止都不关它。</p>
     */
    public void finish(SseEmitter emitter) {
        if (emitter == null) {
            return;
        }
        emitter.complete();
    }

    /**
     * 写前检查并写出单条事件。
     *
     * <p><b>为什么写失败不是告警。</b>SSE 是尽力而为的推送通道，不是可靠投递。执行终态事件
     * 先于收尾用量推送发出，前端看到终态就会关流，于是「终态之后那一条用量推送写不出去」是
     * 每轮都会发生的正常现象，只记 DEBUG。</p>
     *
     * <p><b>为什么写失败要摘流。</b>客户端断开后容器未必立刻回调 onError，继续对它写入只会
     * 每轮重复失败；摘掉这一条，其余流不受影响。会话状态另有历史接口兜底，丢一条推送不影响正确性。</p>
     */
    private void send(long rootSessionId, SseEmitter emitter, AgentEvent event) {
        try {
            emitter.send(SseEmitter
                    .event()
                    .name(event.type())
                    .data(event)
            );
        } catch (Exception e) {
            log.debug("流事件发送失败，摘除该流: error={}", causeSummary(e));
            remove(rootSessionId, emitter);
            try {
                emitter.completeWithError(e);
            } catch (Exception ignored) {
                // 收尾本身失败无所谓：连接已经不可用，注册表也已清理。
            }
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

    /**
     * 心跳：定期给每条连接发一帧命名事件保活。
     *
     * <p><b>为什么不是注释行</b>：SSE 规范要求客户端忽略注释，且 {@code EventSource} 不暴露
     * 任何读取 API —— 用注释做心跳，客户端完全观测不到，只能靠连接不被回收来判断。命名事件
     * 才让前端的连接健康度可见。</p>
     *
     * <p>包可见：便于单测直接触发（生产由 {@code heartbeatScheduler} 每 30s 驱动，无需等待）。</p>
     */
    void heartbeat() {
        Object payload = Map.of("timestamp", System.currentTimeMillis());
        for (Map.Entry<Long, Set<SseEmitter>> entry : emittersByRootSession.entrySet()) {
            for (SseEmitter emitter : entry.getValue()) {
                sendSignal(entry.getKey(), emitter, SignalEvent.HEARTBEAT, payload);
            }
        }
    }

    /**
     * 发送传输层信号帧（就绪 / 心跳）。
     *
     * <p>失败语义与业务投递一致：只记 debug 并摘掉该流，绝不外抛 —— 连接不可用是预期形态，
     * 不能因为发一帧就绪信号失败就把异常抛给调用方。</p>
     */
    private void sendSignal(long rootSessionId, SseEmitter emitter, SignalEvent signal, Object data) {
        try {
            emitter.send(SseEmitter.event().name(signal.name()).data(data));
        } catch (Exception e) {
            log.debug("传输信号发送失败，摘除该流: signal={}, error={}", signal, causeSummary(e));
            remove(rootSessionId, emitter);
            try {
                emitter.completeWithError(e);
            } catch (Exception ignored) {
                // 收尾本身失败无所谓：连接已经不可用，注册表也已清理。
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
}

package com.summit.dp.device.interfaces.ws;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 请求与响应的配对器：把「发出去的 observe/action」和「回来的 observe_result/action_result」对上号。
 *
 * <p>用 reqId / actionId 做键，而不是「等下一个消息」：真实链路上可能同时有保活 pong、
 * 上一条动作的迟到结果、以及别人的通知事件；靠"下一条就是我的"配对，迟早串台。</p>
 *
 * <p>超时一律返回异常而不是 null：调用方必须能把"没等到"和"等到了空"区分开，
 * 这两种情况在真机上处置方式完全相反（前者重新连、后者重新观察）。</p>
 */
public class PendingResponses {

    private final Map<String, CompletableFuture<WireMessage>> waiting = new ConcurrentHashMap<>();

    /** 登记一个待响应。键重复说明调用方复用了 reqId —— 那是缺陷，当场暴露。 */
    public CompletableFuture<WireMessage> register(String correlationId) {
        if (correlationId == null || correlationId.isBlank()) {
            throw new IllegalArgumentException("关联标识不能为空");
        }
        CompletableFuture<WireMessage> future = new CompletableFuture<>();
        CompletableFuture<WireMessage> existing = waiting.putIfAbsent(correlationId, future);
        if (existing != null) {
            throw new IllegalStateException("关联标识重复登记: " + correlationId);
        }
        return future;
    }

    /** 收到响应：唤醒等待者。没人等就直接丢弃——迟到结果不该抛异常打断接收循环。 */
    public void complete(String correlationId, WireMessage message) {
        if (correlationId == null) {
            return;
        }
        CompletableFuture<WireMessage> future = waiting.remove(correlationId);
        if (future != null) {
            future.complete(message);
        }
    }

    /** 等待响应，超时抛 {@link TimeoutException}，让调用方能明确区分"等到"与"没等到"。 */
    public WireMessage await(String correlationId, CompletableFuture<WireMessage> future, Duration timeout)
            throws TimeoutException, InterruptedException {
        try {
            return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            waiting.remove(correlationId);
            throw new TimeoutException("等待设备响应超时: " + correlationId);
        } catch (java.util.concurrent.ExecutionException e) {
            waiting.remove(correlationId);
            throw new IllegalStateException("等待设备响应失败: " + e.getCause(), e.getCause());
        }
    }

    /** 连接断开：所有等待者立即失败，避免线程干等到超时（最坏要 20 秒）。 */
    public void failAll(String reason) {
        waiting.forEach((id, future) -> future.completeExceptionally(new IllegalStateException(reason)));
        waiting.clear();
    }

    public int size() {
        return waiting.size();
    }
}

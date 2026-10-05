package com.summit.dp.stream.infrastructure.transport;

import lombok.extern.slf4j.Slf4j;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import java.util.ArrayDeque;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executor;

/** 网络写入只在发送线程发生，溢出后关闭旧连接而不跳过业务帧。 */
@Slf4j
public final class StreamSubscription {
    private final SseEmitter emitter;
    private final Executor executor;
    private final Runnable remove;
    private final int capacity;
    private static final long MAX_QUEUED_BYTES = 16 * 1024 * 1024;
    private final ArrayDeque<QueuedFrame> queue = new ArrayDeque<>();
    private long queuedBytes;
    private boolean draining;
    private boolean closed;
    private boolean finishing;
    /** 已请求结束连接，但 complete 要等排空线程退出后才发，避免抢在在途 send 前面。 */
    private boolean completing;
    /**
     * @param callbacks 是否由本类向 emitter 注册 onCompletion/onTimeout/onError。
     *     <p><b>为什么需要这个开关</b>：两个生产调用方的回调归属不同 ——
     *     {@code SessionStreamHub} 让本类注册（它只关心「别再往这条连接写」）；
     *     {@code SseEventPublisher} 自己注册（它还要在回调里打连接数日志，
     *     且 {@code remove} 回调就是它自己的方法，由它统一摘注册表）。
     *     若两边都注册，同一次断连会触发两次回调。</p>
     */
    public StreamSubscription(SseEmitter emitter, Executor executor, int capacity, Runnable remove, boolean callbacks) {
        this.emitter = emitter; this.executor = executor; this.capacity = capacity; this.remove = remove;
        if (!callbacks) return;
        emitter.onCompletion(this::close);
        emitter.onTimeout(() -> { close(); emitter.complete(); });
        emitter.onError(error -> close());
    }

    /** 回调归属交由调用方自管时使用，见 {@link #StreamSubscription} 的 {@code callbacks} 说明。 */
    public StreamSubscription(SseEmitter emitter, Executor executor, int capacity, Runnable remove) {
        this(emitter, executor, capacity, remove, true);
    }

    public boolean offer(SseEmitter.SseEventBuilder frame) {
        long bytes = frame.build().stream().mapToLong(part -> String.valueOf(part.getData())
                .getBytes(StandardCharsets.UTF_8).length * 2L + 128).sum();
        synchronized (this) {
            if (closed || finishing) return false;
            if (queue.size() >= capacity || queuedBytes + bytes > MAX_QUEUED_BYTES) {
                closed = true;
                queue.clear();
                queuedBytes = 0;
                // 不在投影门闩内等待网络或执行容器回调。
                executor.execute(() -> { remove.run(); emitter.completeWithError(new IllegalStateException("流队列已满，请重新同步状态")); });
                return false;
            }
            queue.add(new QueuedFrame(frame, bytes));
            queuedBytes += bytes;
            if (!draining) { draining = true; executor.execute(this::drain); }
            return true;
        }
    }
    private void drain() {
        while (true) {
            QueuedFrame frame = null;
            boolean completeAfterDrain = false;
            synchronized (this) {
                if (closed) {
                    draining = false;
                    // 关闭方把 complete 让给了本线程：此刻队列已清空，不会抢在在途 send 前面。
                    completeAfterDrain = completing;
                    completing = false;
                } else if ((frame = queue.poll()) == null) {
                    draining = false;
                    completeAfterDrain = finishing;
                } else {
                    queuedBytes -= frame.bytes();
                }
            }
            if (completeAfterDrain) {
                executor.execute(emitter::complete);
                return;
            }
            if (frame == null) return;
            try { emitter.send(frame.frame()); }
            catch (Exception error) {
                log.debug("断开流订阅: cause={}", error.getClass().getSimpleName());
                // 不走 close()：它会排一个无原因的 complete，抢在 completeWithError 前面就把连接收掉，
                // 前端就分不出「正常结束」与「异常断开」。同 abort：只置位，不补 complete。
                synchronized (this) {
                    closed = true;
                    clearQueue();
                }
                remove.run();
                emitter.completeWithError(error);
                return;
            }
        }
    }

    /**
     * 正常收尾：停止接收新帧、清空待发队列，并真正结束 SSE 连接。
     *
     * <p><b>与 {@link #abort()} 的分工</b>：本方法结束连接但不携带原因，
     * 调用方多为容器回调（{@code onCompletion}/{@code onTimeout}/{@code onError}）
     * 与 {@code @PreDestroy}；{@code abort} 额外带一个原因告诉前端「重新同步状态」。
     * 语义不同所以保留两个方法，不再让 close 只置位而把连接晾着。</p>
     */
    public void close() {
        boolean completeHere;
        synchronized (this) {
            if (closed) return;
            closed = true;
            clearQueue();
            // 排空线程在途时不在本线程 complete：那会抢在未发送的帧前面。改为打标记，
            // 由排空线程退出时发出（见 drain）。closed 与 completing 必须同一个临界区
            // 置位 —— 分两次置会让排空线程在中间观察到「没关闭、也没帧」而直接退出，
            // complete 就永远发不出去了。
            completeHere = !draining;
            completing = !completeHere;
        }
        remove.run();
        if (completeHere) executor.execute(emitter::complete);
    }

    /**
     * 异常中断：带原因关闭，让前端知道要重新同步而不是当成正常结束。
     *
     * <p>这里<b>不能</b>复用 {@link #close()}：close 会排队一个无原因的
     * {@code emitter.complete()}，它一旦抢先执行，{@code completeWithError} 就成了 no-op，
     * 前端会拿不到「需要重新同步」的信号。所以此处不置 {@code completing} ——
     * 排空线程退出时不会再补一个 complete 盖掉错误原因。</p>
     */
    public void abort() {
        synchronized (this) {
            if (closed) return;
            closed = true;
            clearQueue();
        }
        remove.run();
        emitter.completeWithError(new IllegalStateException("实时状态需要重新同步，请重建连接"));
    }

    /** 请求流收尾必须排在最后一帧之后，否则异步发送会丢终态通知。 */
    public void finish() {
        synchronized (this) {
            if (closed || finishing) return;
            finishing = true;
            if (!draining) executor.execute(emitter::complete);
        }
    }

    /** 清空待发队列与字节计数。调用方必须已持有本对象锁。 */
    private void clearQueue() {
        queue.clear();
        queuedBytes = 0;
    }
    private record QueuedFrame(SseEmitter.SseEventBuilder frame, long bytes) { }
}

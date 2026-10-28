package com.summit.dp.session.infrastructure.stream;

import com.summit.dp.session.application.service.SessionStateChanged;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** 应用连接独立于会话订阅，切换会话不会中断侧栏状态。 */
@Slf4j
@Component
public class ApplicationEventStream {
    private final Set<SseEmitter> connections = ConcurrentHashMap.newKeySet();

    public SseEmitter connect() {
        SseEmitter emitter = newEmitter();
        emitter.onCompletion(() -> connections.remove(emitter));
        emitter.onTimeout(() -> close(emitter));
        emitter.onError(error -> close(emitter));

        // 先注册再发就绪信号，客户端同步快照期间的迁移才不会漏掉。
        connections.add(emitter);
        send(emitter, "APPLICATION_READY", Map.of());

        return emitter;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onSessionStateChanged(SessionStateChanged event) {
        for (SseEmitter emitter : connections) {
            send(emitter, "SESSION_STATE", event.session());
        }
    }

    @Scheduled(fixedDelay = 15000)
    public void heartbeat() {
        for (SseEmitter emitter : connections) {
            send(emitter, "HEARTBEAT", Map.of());
        }
    }

    private void send(SseEmitter emitter, String name, Object data) {
        try {
            synchronized (emitter) {
                emitter.send(SseEmitter.event().name(name).data(data));
            }
        } catch (IOException | IllegalStateException error) {
            log.debug("关闭应用事件连接: error={}", error.getMessage());
            close(emitter);
        }
    }

    private void close(SseEmitter emitter) {
        connections.remove(emitter);
        emitter.complete();
    }

    @PreDestroy
    public void shutdown() {
        connections.forEach(this::close);
    }

    protected SseEmitter newEmitter() {
        return new SseEmitter(0L);
    }
}

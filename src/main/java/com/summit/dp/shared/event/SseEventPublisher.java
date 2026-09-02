package com.summit.dp.shared.event;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Server-Sent Events publisher that keeps all connected front-end event streams
 * alive and broadcasts agent runtime events to them in real-time.
 *
 * <p>Drop-in replacement for the WebSocket channel: the JSON envelope
 * ({@code type / executionId / timestamp / data}) is unchanged, only the
 * transport differs.</p>
 */
@Slf4j
@Component
public class SseEventPublisher {

    private static final long HEARTBEAT_INTERVAL_SECONDS = 30;

    private final Set<SseEmitter> emitters = new CopyOnWriteArraySet<>();
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

    /** Registers a new client event stream; returns the emitter to write to. */
    public SseEmitter connect() {
        SseEmitter emitter = new SseEmitter(0L); // never time out; rely on heartbeat + client close
        emitters.add(emitter);
        emitter.onCompletion(() -> {
            emitters.remove(emitter);
            log.info("SSE connection completed, total={}", emitters.size());
        });
        emitter.onTimeout(() -> {
            emitters.remove(emitter);
            log.info("SSE connection timed out, total={}", emitters.size());
            emitter.complete();
        });
        emitter.onError(e -> {
            emitters.remove(emitter);
            log.warn("SSE connection error, error={}", e.getMessage());
        });
        log.info("SSE connected, total={}", emitters.size());
        return emitter;
    }

    /**
     * Broadcast a raw JSON message to all open SSE event streams.
     *
     * @param payload the JSON payload to send
     */
    public void broadcast(String payload) {
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event().name("message").data(payload));
            } catch (IOException | IllegalStateException e) {
                log.warn("Failed to send SSE event, error={}", e.getMessage());
                emitters.remove(emitter);
            }
        }
    }

    /** Sends a comment line to keep idle connections alive across proxies. */
    private void heartbeat() {
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (IOException | IllegalStateException e) {
                emitters.remove(emitter);
            }
        }
    }

    public int connectedCount() {
        return emitters.size();
    }
}

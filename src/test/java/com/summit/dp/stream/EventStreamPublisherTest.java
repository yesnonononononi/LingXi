package com.summit.dp.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * v3 直投发布器回归：连接登记即排 STREAM_READY、信封字段完整、eventId 单次生成、按连接共享同一帧。
 *
 * <p>本类只测「发布 → 传输」，不触碰任何业务库；发布器本身不持有 Repository（零 SQL）。</p>
 */
class EventStreamPublisherTest {

    private static final long ROOT_SESSION_ID = 100L;

    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();
    private final List<BlockingQueue<String>> delivered = new ArrayList<>();
    private EventStreamPublisher publisher;

    @AfterEach
    void shutdown() {
        if (publisher != null) {
            publisher.close();
        }
    }

    @Test
    void subscribeEnqueuesStreamReadyWithoutBusinessState() throws Exception {
        publisher = newPublisher();
        publisher.subscribe(ROOT_SESSION_ID);

        JsonNode frame = next(0);
        assertEquals(StreamV3EventType.STREAM_READY.wireValue(), frame.get("type").asText());
        assertEquals(StreamV3EventType.SCHEMA_VERSION, frame.get("schemaVersion").asInt());
        assertNotNull(frame.get("eventId").asText());
        JsonNode data = frame.get("data");
        assertEquals(StreamV3EventType.SCHEMA_VERSION, data.get("schemaVersion").asInt());
        assertNotNull(data.get("connectionId").asText());
    }

    @Test
    void envelopeCarriesEveryIdentityFieldAndOmitsUnusedLegacyFields() throws Exception {
        publisher = newPublisher();
        publisher.subscribe(ROOT_SESSION_ID);
        next(0); // 丢弃 STREAM_READY

        StreamV3Event event = StreamV3Event.of("9001",
                new StreamV3Event.Identity("100", "101", "200", "300", "3", "8001"),
                StreamV3EventType.THINKING_DELTA, Instant.parse("2026-01-02T03:04:05Z"),
                new StreamV3Payloads.Delta("8001", "分析"));
        publisher.publish(ROOT_SESSION_ID, event);

        JsonNode frame = next(0);
        assertEquals(3, frame.get("schemaVersion").asInt());
        assertEquals("9001", frame.get("eventId").asText());
        assertEquals("100", frame.get("rootSessionId").asText());
        assertEquals("101", frame.get("sessionId").asText());
        assertEquals("200", frame.get("turnId").asText());
        assertEquals("300", frame.get("executionId").asText());
        assertEquals("3", frame.get("historyRevision").asText());
        assertEquals("8001", frame.get("streamKey").asText());
        assertEquals("THINKING_DELTA", frame.get("type").asText());
        assertEquals("分析", frame.get("data").get("delta").asText());
        // §4：不设 seq / streamEpoch / projectionStamp / Last-Event-ID。
        assertFalse(frame.has("seq"));
        assertFalse(frame.has("streamEpoch"));
        assertFalse(frame.has("projectionStamp"));
    }

    @Test
    void eventIdAndFrameAreSharedAcrossConnections() throws Exception {
        publisher = newPublisher();
        publisher.subscribe(ROOT_SESSION_ID);
        publisher.subscribe(ROOT_SESSION_ID);
        next(0);
        next(1);

        StreamV3Event event = StreamV3Event.of("7777",
                new StreamV3Event.Identity("100", "101", null, "300", "3", "8001"),
                StreamV3EventType.TEXT_DELTA, Instant.now(), new StreamV3Payloads.Delta("8001", "片段"));
        publisher.publish(ROOT_SESSION_ID, event);

        JsonNode first = next(0);
        JsonNode second = next(1);
        // 同一帧广播给各连接：eventId 与整帧 JSON 完全一致，不每连接重新生成。
        assertEquals("7777", first.get("eventId").asText());
        assertEquals("7777", second.get("eventId").asText());
        assertEquals(first, second);
    }

    @Test
    void publishWithoutSubscribersIsSilentlySkipped() {
        publisher = newPublisher();
        // 无订阅者：不抛异常、不缓存；不初始化任何投影。
        publisher.publish(ROOT_SESSION_ID, StreamV3Event.of("1",
                new StreamV3Event.Identity("100", null, null, null, null, null),
                StreamV3EventType.TEXT_DELTA, Instant.now(), null));
        assertTrue(delivered.isEmpty());
    }

    @Test
    void missingStreamKeySerializesAsNullWithoutBreakingFrame() throws Exception {
        publisher = newPublisher();
        publisher.subscribe(ROOT_SESSION_ID);
        next(0);

        publisher.publish(ROOT_SESSION_ID, StreamV3Event.of("2",
                new StreamV3Event.Identity("100", "101", null, "300", "3", null),
                StreamV3EventType.SESSION_UPDATED, Instant.now(),
                new StreamV3Payloads.HistoryInvalidated("100", "4", List.of(), List.of())));

        JsonNode frame = next(0);
        assertTrue(frame.has("streamKey"));
        assertTrue(frame.get("streamKey").isNull());
    }

    private EventStreamPublisher newPublisher() {
        return new EventStreamPublisher(json) {
            @Override
            protected SseEmitter newEmitter() {
                SseEmitter emitter = mock(SseEmitter.class);
                BlockingQueue<String> frames = new LinkedBlockingQueue<>();
                delivered.add(frames);
                try {
                    doAnswer(call -> {
                        SseEmitter.SseEventBuilder builder = call.getArgument(0);
                        for (SseEmitter.DataWithMediaType part : builder.build()) {
                            Object data = part.getData();
                            // build() 会产出 "event:NAME"、"data:" 前缀等条目；只取真正的 JSON 载荷。
                            if (data instanceof String text && text.startsWith("{")) {
                                frames.add(text);
                            }
                        }
                        return null;
                    }).when(emitter).send(any(SseEmitter.SseEventBuilder.class));
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
                return emitter;
            }
        };
    }

    private JsonNode next(int connection) throws Exception {
        String frame = delivered.get(connection).poll(5, TimeUnit.SECONDS);
        assertNotNull(frame, "连接 " + connection + " 未收到帧");
        return json.readTree(frame);
    }
}

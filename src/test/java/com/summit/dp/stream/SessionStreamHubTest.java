package com.summit.dp.stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.stream.application.projection.StreamProjectionReducer;
import com.summit.dp.stream.application.projection.StreamRoundRegistry;
import com.summit.dp.stream.application.projection.RootProjection;
import java.time.Instant;
import com.summit.dp.stream.application.protocol.StreamEventEnvelope;
import com.summit.dp.stream.application.protocol.StreamOperation;
import com.summit.dp.stream.application.protocol.StreamSnapshot;
import com.summit.dp.stream.application.service.SessionStreamHub;
import com.summit.dp.stream.application.service.StreamSnapshotAssembler;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.any;

class SessionStreamHubTest {
    private final ObjectMapper json = new JsonConfig().objectMapper();
    private final StreamSnapshotAssembler assembler = mock(StreamSnapshotAssembler.class);
    private final StreamRoundRegistry rounds = new StreamRoundRegistry(json);
    private final List<BlockingQueue<StreamEventEnvelope>> delivered = new ArrayList<>();
    private final CountDownLatch blocked = new CountDownLatch(1);
    private final CountDownLatch release = new CountDownLatch(1);
    private boolean blockFirst;
    private SessionStreamHub hub;
    @SuppressWarnings("unchecked")
    private void start(StreamSnapshotAssembler.Base base) throws Exception {
        when(assembler.load(1L)).thenReturn(base);
        ObjectProvider<SseEventPublisher> legacy = mock(ObjectProvider.class);
        when(legacy.getObject()).thenReturn(mock(SseEventPublisher.class));
        hub = new SessionStreamHub(assembler, new StreamProjectionReducer(), rounds, json, legacy) {
            @Override protected SseEmitter newEmitter() {
                SseEmitter emitter = mock(SseEmitter.class);
                BlockingQueue<StreamEventEnvelope> frames = new LinkedBlockingQueue<>();
                delivered.add(frames);
                boolean mustBlock = blockFirst && delivered.size() == 1;
                try {
                    doAnswer(call -> {
                        SseEmitter.SseEventBuilder builder = call.getArgument(0);
                        for (SseEmitter.DataWithMediaType part : builder.build()) {
                            if (part.getData() instanceof StreamEventEnvelope frame) {
                                if (mustBlock && frame.type().equals("STREAM_SNAPSHOT")) {
                                    blocked.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS));
                                }
                                frames.add(frame);
                            }
                        }
                        return null;
                    }).when(emitter).send(any(SseEmitter.SseEventBuilder.class));
                } catch (Exception error) { throw new IllegalStateException(error); }
                return emitter;
            }
        };
    }
    private StreamSnapshotAssembler.Base empty() { return new StreamSnapshotAssembler.Base(1, List.of(), List.of(), List.of(), List.of(), List.of()); }
    private void delta(String text) throws Exception {
        ObjectNode event = json.createObjectNode().put("type", "PARTIAL_TEXT").put("sessionId", "1")
                .put("turnId", "7").put("executionId", "11").put("content", text);
        hub.publishLegacy(1, json.writeValueAsString(event));
    }
    private StreamEventEnvelope next(int connection) throws Exception {
        StreamEventEnvelope frame = delivered.get(connection).poll(5, TimeUnit.SECONDS);
        assertNotNull(frame); return frame;
    }
    @AfterEach void close() { release.countDown(); if (hub != null) hub.close(); }

    @Test void noSubscriberRetainsUtf16TextAndCommittedRowBindsOriginalKey() throws Exception {
        start(empty()); delta("中😀"); delta("文");
        StreamSnapshot live = hub.snapshot(1);
        ObjectNode message = live.messages().getFirst();
        assertEquals("中😀文", message.path("text").asText());
        assertEquals(4, message.path("textOffset").asInt());
        String key = message.path("streamKey").asText();
        ObjectNode committed = json.createObjectNode().put("streamKey", key).put("id", "90")
                .put("text", "中😀文").put("blockVersion", "1").put("committed", true);
        hub.publish(1, StreamOperation.create("1", "7", null, "1", "MESSAGE_COMMITTED", json.createObjectNode().set("message", committed)));
        StreamSnapshot bound = hub.snapshot(1);
        assertEquals(1, bound.messages().size());
        assertEquals("90", bound.messages().getFirst().path("id").asText());
        assertEquals(key, bound.messages().getFirst().path("streamKey").asText());
        assertEquals("11", bound.messages().getFirst().path("executionId").asText());
    }
    @Test void snapshotIsFirstAndTwoConnectionsShareEventIdentityWithoutBlockingPublisher() throws Exception {
        blockFirst = true; start(empty()); hub.subscribe(1);
        assertTrue(blocked.await(5, TimeUnit.SECONDS));
        delta("a"); hub.subscribe(1);
        StreamEventEnvelope secondSnapshot = next(1);
        assertEquals("STREAM_SNAPSHOT", secondSnapshot.type()); assertEquals("1", secondSnapshot.seq());
        delta("b");
        StreamEventEnvelope secondDelta = next(1);
        release.countDown();
        assertEquals("0", next(0).seq());
        StreamEventEnvelope firstDelta = next(0);
        assertEquals("1", firstDelta.seq());
        assertEquals("TEXT_DELTA", firstDelta.type()); assertFalse(firstDelta.payload().has("message"));
        StreamEventEnvelope shared = next(0);
        assertEquals("2", shared.seq());
        assertEquals(secondDelta.eventId(), shared.eventId());
        assertEquals(secondDelta.streamEpoch(), shared.streamEpoch());
    }
    @Test void calibrationConsumesSequenceAndRollbackRejectsLateOldGeneration() throws Exception {
        ObjectNode session = json.createObjectNode().put("id", "1").put("version", "1").put("name", "旧名称");
        start(new StreamSnapshotAssembler.Base(1, List.of(session), List.of(), List.of(), List.of(), List.of()));
        hub.subscribe(1); next(0);
        ObjectNode changed = session.deepCopy().put("version", "2").put("name", "新名称");
        when(assembler.load(1L)).thenReturn(new StreamSnapshotAssembler.Base(1, List.of(changed), List.of(), List.of(), List.of(), List.of()));
        assertEquals("1", hub.snapshot(1).watermark());
        assertEquals("SESSION_UPDATED", next(0).type());
        delta("旧回答"); next(0);
        ObjectNode invalidation = json.createObjectNode().put("historyRevision", "2");
        invalidation.putArray("turnIds").add("7"); invalidation.putArray("executionIds").add("11");
        hub.publish(1, StreamOperation.create("1", null, null, null, "HISTORY_INVALIDATED", invalidation)); next(0);
        delta("迟到文本");
        StreamSnapshot snapshot = hub.snapshot(1);
        assertEquals("2", snapshot.historyRevision()); assertTrue(snapshot.messages().isEmpty());
        assertEquals("3", snapshot.watermark());
    }
    @SuppressWarnings("unchecked")
    @Test void v1AndV2ConnectionsReceiveOnlyTheirOwnSchema() throws Exception {
        start(empty()); hub.subscribe(1); next(0);
        SseEmitter v1Emitter = mock(SseEmitter.class);
        BlockingQueue<Object> raw = new LinkedBlockingQueue<>();
        doAnswer(call -> {
            SseEmitter.SseEventBuilder builder = call.getArgument(0);
            builder.build().stream().filter(part -> part.getData() instanceof String data && data.contains("PARTIAL_TEXT"))
                    .forEach(part -> raw.add(part.getData())); return null;
        }).when(v1Emitter).send(any(SseEmitter.SseEventBuilder.class));
        SseEventPublisher publisher = new SseEventPublisher() {
            @Override protected SseEmitter newEmitter() { return v1Emitter; }
        };
        try {
            ObjectProvider<SessionStreamHub> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(hub); ReflectionTestUtils.setField(publisher, "hub", provider);
            ObjectProvider<SseEventPublisher> legacy = mock(ObjectProvider.class);
            when(legacy.getObject()).thenReturn(publisher); ReflectionTestUtils.setField(hub, "legacy", legacy);
            publisher.connect(1);
            publisher.publish(1, "{\"type\":\"PARTIAL_TEXT\",\"executionId\":\"11\",\"sessionId\":\"1\",\"turnId\":\"7\",\"content\":\"abc\"}");
            StreamEventEnvelope v2 = next(0);
            assertEquals(2, v2.schemaVersion()); assertEquals("TEXT_DELTA", v2.type());
            assertEquals("abc", v2.payload().path("delta").asText());
            assertTrue(raw.poll(5, TimeUnit.SECONDS) instanceof String);
        } finally { publisher.close(); }
    }
    @Test void contradictoryVersionClosesOldEpochAndCalibrationCanBuildNewEpoch() throws Exception {
        ObjectNode session = json.createObjectNode().put("id", "1").put("version", "1").put("name", "正确名称");
        start(new StreamSnapshotAssembler.Base(1, List.of(session), List.of(), List.of(), List.of(), List.of()));
        String epoch = hub.snapshot(1).streamEpoch();
        delta("尚未落库");
        assertThrows(IllegalStateException.class, () -> hub.publish(1, StreamOperation.create("1", null, null, "1", "SESSION_UPDATED",
                json.createObjectNode().set("session", session.deepCopy().put("name", "矛盾数据")))));
        StreamSnapshot recovered = hub.snapshot(1);
        assertNotEquals(epoch, recovered.streamEpoch());
        assertEquals("正确名称", recovered.sessions().getFirst().path("name").asText());
        assertEquals("尚未落库", recovered.messages().getFirst().path("text").asText());
    }
    @SuppressWarnings("unchecked")
    @Test void ttlKeepsSuspendedRootAndReclaimsOnlyInactiveTerminalRoot() throws Exception {
        ObjectNode execution = json.createObjectNode().put("id", "11").put("sessionId", "1").put("version", "1").put("status", 2);
        start(new StreamSnapshotAssembler.Base(1, List.of(), List.of(), List.of(execution), List.of(), List.of()));
        String epoch = hub.snapshot(1).streamEpoch();
        Map<Long, Object> roots = (Map<Long, Object>) ReflectionTestUtils.getField(hub, "roots");
        RootProjection projection = (RootProjection) ReflectionTestUtils.getField(roots.get(1L), "projection");
        projection.lastTouched = Instant.now().minusSeconds(601);
        ReflectionTestUtils.invokeMethod(hub, "maintain");
        assertEquals(epoch, hub.snapshot(1).streamEpoch());
        ObjectNode terminal = execution.deepCopy().put("version", "2").put("status", 3);
        when(assembler.load(1L)).thenReturn(new StreamSnapshotAssembler.Base(1, List.of(), List.of(), List.of(terminal), List.of(), List.of()));
        hub.snapshot(1); projection.lastTouched = Instant.now().minusSeconds(601);
        ReflectionTestUtils.invokeMethod(hub, "maintain");
        assertTrue(roots.isEmpty()); assertNotEquals(epoch, hub.snapshot(1).streamEpoch());
    }
    @Test void newEpochUsesCommittedFullTextWhenItsNotificationWasMissed() throws Exception {
        ObjectNode session = json.createObjectNode().put("id", "1").put("version", "1").put("name", "正确名称");
        start(new StreamSnapshotAssembler.Base(1, List.of(session), List.of(), List.of(), List.of(), List.of()));
        delta("已收到的前缀");
        String key = hub.snapshot(1).messages().getFirst().path("streamKey").asText();
        assertThrows(IllegalStateException.class, () -> hub.publish(1, StreamOperation.create("1", null, null, "1", "SESSION_UPDATED",
                json.createObjectNode().set("session", session.deepCopy().put("name", "矛盾数据")))));
        ObjectNode committed = json.createObjectNode().put("streamKey", key).put("id", "90").put("text", "已接纳的完整回答")
                .put("blockVersion", "1").put("committed", true).put("finalized", true);
        when(assembler.load(1L)).thenReturn(new StreamSnapshotAssembler.Base(1, List.of(session), List.of(), List.of(), List.of(committed), List.of()));
        ObjectNode restored = hub.snapshot(1).messages().getFirst();
        assertEquals(key, restored.path("streamKey").asText());
        assertEquals("已接纳的完整回答", restored.path("text").asText());
        assertEquals("90", restored.path("id").asText()); assertTrue(restored.path("committed").asBoolean());
    }
}

package com.summit.dp.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.stream.infrastructure.StreamResponseIdentityInterceptor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * 响应身份拦截器回归：每轮无条件生成新的 {@code streamKey}、写回事件元数据、直投 {@code RESPONSE_STARTED}，
 * 且不得破坏已有的归属字段；发帧失败不致命。
 */
class StreamResponseIdentityInterceptorTest {

    private static final long ROOT_SESSION_ID = 100L;

    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();
    private final List<BlockingQueue<String>> delivered = new ArrayList<>();
    private final EventStreamPublisher publisher = publishingCaptured();
    private final StreamResponseIdentityInterceptor interceptor = new StreamResponseIdentityInterceptor(publisher);

    @AfterEach
    void shutdown() {
        publisher.close();
    }

    @Test
    @DisplayName("连续两轮生成不同的 streamKey：每轮响应各自身份")
    void generatesFreshKeyPerRound() {
        Execution execution = execution(Map.of(
                ExecutionEventMetadata.ROOT_SESSION_ID, "100",
                ExecutionEventMetadata.SESSION_ID, "100",
                ExecutionEventMetadata.TURN_ID, "9001",
                ExecutionEventMetadata.HISTORY_REVISION, "3"));

        interceptor.onBeforeModelInvoke(context(execution));
        String first = ExecutionEventMetadata.streamKey(execution.eventMetaData());

        interceptor.onBeforeModelInvoke(context(execution));
        String second = ExecutionEventMetadata.streamKey(execution.eventMetaData());

        assertNotNull(first);
        assertNotNull(second);
        assertNotEquals(first, second, "每一轮响应必须是新的身份，否则前端会把两轮回答认成同一条");
    }

    @Test
    @DisplayName("写回 streamKey 时原有归属字段原样保留")
    void preservesExistingIdentityFields() {
        Execution execution = execution(Map.of(
                ExecutionEventMetadata.ROOT_SESSION_ID, "100",
                ExecutionEventMetadata.SESSION_ID, "200",
                ExecutionEventMetadata.TURN_ID, "9001",
                ExecutionEventMetadata.PARENT_TURN_ID, "8001",
                ExecutionEventMetadata.HISTORY_REVISION, "3"));

        interceptor.onBeforeModelInvoke(context(execution));

        Map<String, Object> metadata = execution.eventMetaData();
        assertEquals("100", metadata.get(ExecutionEventMetadata.ROOT_SESSION_ID));
        assertEquals("200", metadata.get(ExecutionEventMetadata.SESSION_ID));
        assertEquals("9001", metadata.get(ExecutionEventMetadata.TURN_ID));
        assertEquals("8001", metadata.get(ExecutionEventMetadata.PARENT_TURN_ID));
        assertEquals("3", metadata.get(ExecutionEventMetadata.HISTORY_REVISION));
        assertNotNull(ExecutionEventMetadata.streamKey(metadata));
    }

    @Test
    @DisplayName("一次调用只写入一个键：不会生成两次互相覆盖")
    void writesExactlyOneKeyPerInvocation() {
        Execution execution = execution(Map.of(ExecutionEventMetadata.SESSION_ID, "100"));

        interceptor.onBeforeModelInvoke(context(execution));

        String key = ExecutionEventMetadata.streamKey(execution.eventMetaData());
        assertNotNull(key);
        assertEquals(key, ExecutionEventMetadata.streamKey(execution.eventMetaData()));
        assertEquals(1, execution.eventMetaData().values().stream()
                .filter(key::equals).count(), "同一次调用只允许一个 streamKey 值");
    }

    @Test
    @DisplayName("直投 RESPONSE_STARTED：声明本次响应身份，且与写回的 streamKey 同源")
    void publishesResponseStartedWithSameKey() throws Exception {
        publisher.subscribe(ROOT_SESSION_ID);
        next(0); // 丢弃 STREAM_READY
        Execution execution = execution(Map.of(
                ExecutionEventMetadata.ROOT_SESSION_ID, "100",
                ExecutionEventMetadata.SESSION_ID, "101",
                ExecutionEventMetadata.TURN_ID, "200",
                ExecutionEventMetadata.HISTORY_REVISION, "3"));

        interceptor.onBeforeModelInvoke(context(execution));

        JsonNode frame = next(0);
        assertEquals("RESPONSE_STARTED", frame.get("type").asText());
        assertEquals("100", frame.get("rootSessionId").asText());
        assertEquals("101", frame.get("sessionId").asText());
        assertEquals("200", frame.get("turnId").asText());
        assertEquals("3", frame.get("historyRevision").asText());
        String writtenKey = ExecutionEventMetadata.streamKey(execution.eventMetaData());
        assertEquals(writtenKey, frame.get("streamKey").asText());
        assertEquals(writtenKey, frame.get("data").get("streamKey").asText());
    }

    @Test
    @DisplayName("发帧失败不让整轮失败：异常被吞掉，元数据身份仍已写回")
    void publishFailureIsNotFatal() {
        // 发布器被替换为一个一定抛异常的替身：模拟 SSE 旁路故障。
        EventStreamPublisher failing = new EventStreamPublisher(json) {
            @Override
            protected SseEmitter newEmitter() {
                throw new IllegalStateException("SSE 通道不可用");
            }
        };
        try {
            StreamResponseIdentityInterceptor faultTolerant =
                    new StreamResponseIdentityInterceptor(failing);
            Execution execution = execution(Map.of(
                    ExecutionEventMetadata.ROOT_SESSION_ID, "100",
                    ExecutionEventMetadata.SESSION_ID, "101"));

            InterceptorResult result = assertDoesNotThrow(() -> faultTolerant.onBeforeModelInvoke(context(execution)),
                    "发帧是旁路动作，其失败绝不能让整轮模型调用失败");

            assertEquals(InterceptorResult.NONE, result);
            assertNotNull(ExecutionEventMetadata.streamKey(execution.eventMetaData()),
                    "身份写入不受发帧失败影响");
        } finally {
            failing.close();
        }
    }

    private EventStreamPublisher publishingCaptured() {
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

    private Execution execution(Map<String, Object> metadata) {
        AgentRuntimeParameters parameters = AgentRuntimeParameters.builder()
                .eventMetaData(metadata)
                .build();
        return Execution.builder()
                .id("execution")
                .agentRequest(AgentRequest.builder().runtimeParameters(parameters).build())
                .build();
    }

    private static LoopContext context(Execution execution) {
        return new LoopContext(execution, new ExecutionControlSignal("execution"), 0,
                execution.eventMetaData(), ignored -> { });
    }

    private JsonNode next(int connection) throws Exception {
        String frame = delivered.get(connection).poll(5, TimeUnit.SECONDS);
        assertNotNull(frame, "连接 " + connection + " 未收到帧");
        return json.readTree(frame);
    }
}

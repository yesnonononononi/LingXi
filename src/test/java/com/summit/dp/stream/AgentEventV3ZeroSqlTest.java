package com.summit.dp.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.AgentMessageEvent;
import com.summit.core.conversation.event.AgentPartialTextEvent;
import com.summit.core.conversation.event.AgentPartialThinkingEvent;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 零 SQL 完整链回归：v3 事件从「监听 → 转换 → 发布 → 投递」全程不触碰任何 Mapper/Repository。
 *
 * <p>用「访问即失败」的替身锁死：{@link ExecutionIdentity} 的每个方法都抛异常 —— 只要链路上任何
 * 一处发生身份解析（即一次执行表查询），测试立即失败。这比只看日志强得多。</p>
 */
class AgentEventV3ZeroSqlTest {

    private static final long ROOT_SESSION_ID = 100L;

    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();
    private final List<BlockingQueue<String>> delivered = new ArrayList<>();
    private final EventStreamPublisher publisher = publishingCaptured();
    /** 访问即失败：v3 路径任何一次身份解析都会让本替身抛异常。 */
    private final ExecutionIdentity identity = accessFails();
    private final AgentEventListener listener =
            new AgentEventListener(json, mock(SseEventPublisher.class), identity, publisher);

    @AfterEach
    void shutdown() {
        publisher.close();
    }

    @Test
    void thinkingAndTextDeltasNeverTouchAnyRepository() throws Exception {
        listener.init();
        publisher.subscribe(ROOT_SESSION_ID);
        next(0); // STREAM_READY

        Map<String, Object> metadata = Map.of(
                "rootSessionId", Long.toString(ROOT_SESSION_ID),
                "sessionId", "101",
                "turnId", "200",
                "historyRevision", "3",
                "streamKey", "8001");

        // 一万个片段也不应产生任何查询（此处抽样若干，验证链路形态而非规模）。
        for (int index = 0; index < 32; index++) {
            listener.onPartialThinking(new AgentPartialThinkingEvent("agent", "300", "思考" + index, metadata, null));
            listener.onPartialText(new AgentPartialTextEvent("agent", "300", "正文" + index, metadata, null));
        }

        JsonNode thinking = next(0);
        assertEquals("THINKING_DELTA", thinking.get("type").asText());
        assertEquals("8001", thinking.get("streamKey").asText());
        assertEquals("思考0", thinking.get("data").get("delta").asText());

        JsonNode text = next(0);
        assertEquals("TEXT_DELTA", text.get("type").asText());
        assertEquals("正文0", text.get("data").get("delta").asText());
    }

    @Test
    void finalizedMessageUsesSameKeyWithoutLookup() throws Exception {
        listener.init();
        publisher.subscribe(ROOT_SESSION_ID);
        next(0);

        Map<String, Object> metadata = Map.of(
                "rootSessionId", Long.toString(ROOT_SESSION_ID),
                "sessionId", "101",
                "turnId", "200",
                "historyRevision", "3",
                "streamKey", "8001");

        listener.onAiMessage(new AgentMessageEvent("完整正文", "完整思考", "300", metadata));

        JsonNode frame = next(0);
        assertEquals("RESPONSE_FINALIZED", frame.get("type").asText());
        assertEquals("8001", frame.get("streamKey").asText());
        JsonNode data = frame.get("data");
        assertEquals("完整正文", data.get("text").asText());
        assertEquals("完整思考", data.get("thinking").asText());
    }

    @Test
    void eventWithoutRootSessionRoutesToLegacyAndNeverReachesV3Publisher() throws Exception {
        // 缺失 rootSessionId = 该执行自身仍是 v2 协议：必须回落到 legacy 链，绝不能被 v3 发布器猜着投。
        // 这是「按执行自身的协议版本分流」判据的反向证据 —— 判据是元数据里有没有 rootSessionId，
        // 不是请求参数；缺失即代表这条事件不属于 v3。
        ExecutionIdentity legacy = mock(ExecutionIdentity.class);
        when(legacy.sessionId("300")).thenReturn(101L);
        when(legacy.resolveRootSessionId(101L)).thenReturn(ROOT_SESSION_ID);
        AgentEventListener legacyListener =
                new AgentEventListener(json, mock(SseEventPublisher.class), legacy, publisher);
        legacyListener.init();

        Map<String, Object> metadata = Map.of("sessionId", "101", "streamKey", "8001");
        legacyListener.onPartialText(new AgentPartialTextEvent("agent", "300", "片段", metadata, null));

        // v3 发布器完全没有被登记过连接：delivered 为空，说明该事件没走 v3 直投。
        assertTrue(delivered.isEmpty());
        // 反向确认走了 legacy：执行身份被查询（legacy 链的既有行为，保持不变）。
        verify(legacy).sessionId("300");
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

    /** 「访问即失败」替身：任何身份解析调用都抛异常，用于锁死零 SQL。 */
    private static ExecutionIdentity accessFails() {
        return new ExecutionIdentity(null, null) {
            @Override
            public long sessionId(String executionId) {
                throw new AssertionError("v3 链路不得解析执行身份（发生了一次 SQL）");
            }

            @Override
            public long resolveRootSessionId(long sessionId) {
                throw new AssertionError("v3 链路不得解析根会话（发生了一次 SQL）");
            }

            @Override
            public String latestSuspendedExecutionId(long sessionId) {
                throw new AssertionError("v3 链路不得查询挂起执行");
            }

            @Override
            public List<String> activeExecutionIds(long sessionId) {
                throw new AssertionError("v3 链路不得查询活跃执行");
            }
        };
    }

    private JsonNode next(int connection) throws Exception {
        String frame = delivered.get(connection).poll(5, TimeUnit.SECONDS);
        assertNotNull(frame, "连接 " + connection + " 未收到帧");
        return json.readTree(frame);
    }
}

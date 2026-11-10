package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.model.ObserveMode;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.device.interfaces.ws.PendingResponses;
import com.summit.dp.device.interfaces.ws.SeqGuard;
import com.summit.dp.device.interfaces.ws.WireMessage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * WSS 通道的闭环测试。
 *
 * <p>用 Mockito 假会话 + 「发送即应答」的方式，把异步配对变成确定性行为：
 * 真机上很难复现「结果晚到 / 重连重放 / 缺字段」，而这几种恰恰是这个通道存在的全部理由。</p>
 */
class WsDeviceChannelTest {

    private static final String DEVICE_ID = "px7a-ws";

    private final ObjectMapper mapper = new ObjectMapper();
    private final DevicePayloadMapper payloadMapper = new DevicePayloadMapper(mapper);
    private WebSocketSession session;
    private DeviceWsProperties properties;
    private AtomicReference<WsDeviceChannel> holder;

    @BeforeEach
    void setUp() {
        session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        when(session.getId()).thenReturn("s-1");

        properties = new DeviceWsProperties();
        properties.setTransport("ws");
        properties.setObserveTimeout(Duration.ofMillis(500));
        properties.setActionTimeout(Duration.ofMillis(500));

        holder = new AtomicReference<>();
    }

    private WsDeviceChannel newChannel() {
        Device device = new Device(
                DEVICE_ID, "0.1.0", 33,
                Set.of(DeviceCapability.NODE_TREE, DeviceCapability.GESTURES),
                new DeviceScreen(1080, 2400, 2.75f, 0),
                System.currentTimeMillis());
        WsDeviceChannel channel = new WsDeviceChannel(
                session, mapper, payloadMapper, new PendingResponses(), new SeqGuard(), properties, device);
        holder.set(channel);
        return channel;
    }

    /**
     * 给假会话装发送行为。
     *
     * <p>包一层的原因：{@code doAnswer(..).when(session).sendMessage(..)} 末尾这次调用声明了
     * {@code IOException}，不包的话每个用例都得写 throws，噪音远大于收益。</p>
     */
    private void stubSend(Answer<Void> answer) {
        try {
            doAnswer(answer).when(session).sendMessage(any());
        } catch (java.io.IOException e) {
            throw new IllegalStateException("装桩失败", e);
        }
    }

    /** 发送即应答：从发出的信封里取出 reqId / actionId，立刻回一条对得上的结果。 */
    private void respondOnSend(Function<String, String> buildResponse) {
        AtomicLong seq = new AtomicLong(100);
        stubSend(invocation -> {
            TextMessage sent = invocation.getArgument(0);
            String response = buildResponse.apply(sent.getPayload());
            if (response != null) {
                // 每条应答换一个 seq：序号守卫按「严格递增」判重，复用同一个 seq 会被自己丢掉
                WireMessage wire = WireMessage.parse(mapper, withSeq(response, seq.getAndIncrement()));
                if (wire == null) {
                    throw new IllegalStateException("测试构造的应答无法解析: " + response);
                }
                holder.get().handleInbound(wire);
            }
            return null;
        });
    }

    private String withSeq(String json, long newSeq) {
        try {
            ObjectNode node = (ObjectNode) mapper.readTree(json);
            node.put("seq", newSeq);
            return mapper.writeValueAsString(node);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String correlationOf(String payload) {
        WireMessage envelope = WireMessage.parse(mapper, payload);
        if (envelope == null) {
            throw new IllegalStateException("无法解析出站信封: " + payload);
        }
        var p = envelope.payload();
        return p.has("reqId") ? p.get("reqId").asText() : p.get("actionId").asText();
    }

    private String observeResult(String reqId) {
        return """
                {"v":1,"type":"observe_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                  "reqId":"%s","screen":{"w":1080,"h":2400,"density":2.75,"rotation":0},
                  "frameHash":"fh-ws-1","focusedPkg":"com.android.settings","truncated":false,
                  "nodes":[{"idx":0,"role":"switch","text":"WLAN","bounds":{"x1":37,"y1":125,"x2":963,"y2":158},
                            "clickable":true,"enabled":true,"checked":true,"depth":2}]
                }}
                """.formatted(reqId, DEVICE_ID, reqId);
    }

    @Test
    void 观察能把设备返回映射成快照() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            WireMessage envelope = WireMessage.parse(mapper, sent);
            boolean hasRequired = envelope != null
                    && envelope.payload().has("mode")
                    && envelope.payload().has("maxNodes");
            assertTrue(hasRequired, "observe 缺少必填字段: " + sent);
            return observeResult(correlationOf(sent));
        });

        ObserveSnapshot snapshot = channel.observe(80);

        assertEquals("fh-ws-1", snapshot.frameHash());
        assertEquals("com.android.settings", snapshot.focusedPackage());
        assertEquals(1, snapshot.elements().size());
        assertEquals("WLAN", snapshot.elements().get(0).text());
        assertTrue(snapshot.elements().get(0).checked());
        assertEquals("com.android.settings", channel.foregroundPackage(), "前台包名要缓存给危险判定用");
    }

    @Test
    void 观察请求如实上报模式_只取节点时不要截图() {
        WsDeviceChannel channel = newChannel();
        AtomicReference<String> sentPayload = new AtomicReference<>();
        respondOnSend(sent -> {
            sentPayload.set(sent);
            return observeResult(correlationOf(sent));
        });

        channel.observe(80);

        WireMessage envelope = WireMessage.parse(mapper, sentPayload.get());
        // 曾经把 mode 写死成 both 再丢掉截图：设备白截一张图，白白多花约 300ms。
        // 这条断言就是防它回来。
        assertEquals("nodes", envelope.payload().get("mode").asText(),
                "只取节点就必须说 nodes，否则设备会白截一张没人看的图");
        assertFalse(envelope.payload().get("includeScreenshot").asBoolean(true),
                "不要截图时 includeScreenshot 必须是 false");
    }

    @Test
    void 观察带截图时能解析出图片字节与像素空间() {
        WsDeviceChannel channel = newChannel();
        String base64 = java.util.Base64.getEncoder().encodeToString(new byte[]{1, 2, 3, 4, 5});
        AtomicReference<String> sentPayload = new AtomicReference<>();
        respondOnSend(sent -> {
            sentPayload.set(sent);
            String reqId = correlationOf(sent);
            return """
                    {"v":1,"type":"observe_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "reqId":"%s","screen":{"w":1080,"h":2376,"density":3,"rotation":0},
                      "frameHash":"fh-shot","focusedPkg":"com.android.settings","truncated":false,"nodes":[],
                      "screenshot":{"shotB64":"%s","width":727,"height":1600,
                                    "rawWidth":1080,"rawHeight":2376,"mimeType":"image/jpeg"}
                    }}
                    """.formatted(reqId, DEVICE_ID, reqId, base64);
        });

        ObserveSnapshot snapshot = channel.observe(new ObserveRequest(80, ObserveMode.SHOT));

        WireMessage envelope = WireMessage.parse(mapper, sentPayload.get());
        assertEquals("shot", envelope.payload().get("mode").asText());
        assertTrue(envelope.payload().get("includeScreenshot").asBoolean(false));

        DeviceScreenshot screenshot = snapshot.screenshot();
        assertNotNull(screenshot, "带截图却解析不出来，等于把唯一能看的东西丢了");
        assertEquals(5, screenshot.image().length);
        assertEquals(727, screenshot.width());
        assertEquals(1600, screenshot.height());
        assertEquals("image/jpeg", screenshot.mimeType());
        assertEquals(DeviceScreenshot.CoordinateSpace.MATCH, screenshot.coordinateSpace(snapshot.screen()));
    }

    @Test
    void 截图缺图片宽高时仍是可解析的_但要在文本里告警() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            String reqId = correlationOf(sent);
            // 协议允许"只让我看一眼"，所以不缺字段就不该拒绝；但换算不出坐标这件事必须说出来
            return """
                    {"v":1,"type":"observe_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "reqId":"%s","screen":{"w":1080,"h":2376,"density":3,"rotation":0},
                      "frameHash":"fh-shot","focusedPkg":"com.android.settings","truncated":false,"nodes":[],
                      "screenshot":{"shotB64":"AAEC","rawWidth":1080,"rawHeight":2376}
                    }}
                    """.formatted(reqId, DEVICE_ID, reqId);
        });

        ObserveSnapshot snapshot = channel.observe(new ObserveRequest(80, ObserveMode.BOTH));

        assertFalse(snapshot.screenshot().hasImageSize());
        assertTrue(snapshot.toPromptText().contains("无法把图上的像素换算"),
                snapshot.toPromptText());
    }

    @Test
    void 截图只给一半尺寸必须报错() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            String reqId = correlationOf(sent);
            // 只给宽度：这是对面实现不一致，不能猜，必须拒
            return """
                    {"v":1,"type":"observe_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "reqId":"%s","screen":{"w":1080,"h":2376,"density":3,"rotation":0},
                      "frameHash":"fh-shot","focusedPkg":"com.android.settings","truncated":false,"nodes":[],
                      "screenshot":{"shotB64":"AAEC","width":727}
                    }}
                    """.formatted(reqId, DEVICE_ID, reqId);
        });

        assertThrows(DeviceUnavailableException.class,
                () -> channel.observe(new ObserveRequest(80, ObserveMode.BOTH)));
    }

    @Test
    void 观察结果缺帧指纹必须报错而不是兜底() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            String reqId = correlationOf(sent);
            // 故意抽掉 frameHash
            return """
                    {"v":1,"type":"observe_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "reqId":"%s","screen":{"w":1080,"h":2400,"density":2.75,"rotation":0},
                      "focusedPkg":"com.android.settings","truncated":false,"nodes":[]
                    }}
                    """.formatted(reqId, DEVICE_ID, reqId);
        });

        DeviceUnavailableException exception = assertThrows(DeviceUnavailableException.class,
                () -> channel.observe(80));
        assertTrue(exception.getMessage().contains("frameHash"),
                "缺帧指纹等于把动作的前置校验悄悄关掉，必须当场炸");
    }

    @Test
    void 动作成功会带出稳定判定() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            String actionId = correlationOf(sent);
            return """
                    {"v":1,"type":"action_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "actionId":"%s","ok":true,
                      "settled":{"idleMs":280,"changed":true,"frameHash":"fh-ws-2"}
                    }}
                    """.formatted(actionId, DEVICE_ID, actionId);
        });

        ActionOutcome outcome = channel.perform(new ActionRequest(
                "a-1", "tap", Map.of("point", Map.of("x", 500, "y", 140)), "fh-ws-1", "WLAN"));

        assertTrue(outcome.ok());
        assertEquals(280, outcome.idleMs());
        assertEquals(Boolean.TRUE, outcome.screenChanged());
        assertEquals("fh-ws-2", outcome.frameHash());
    }

    @Test
    void 动作出站必须带expect帧指纹() {
        WsDeviceChannel channel = newChannel();
        AtomicReference<String> captured = new AtomicReference<>();
        respondOnSend(sent -> {
            captured.set(sent);
            String actionId = correlationOf(sent);
            return """
                    {"v":1,"type":"action_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{"actionId":"%s","ok":true}}
                    """.formatted(actionId, DEVICE_ID, actionId);
        });

        channel.perform(new ActionRequest(
                "a-2", "tap", Map.of("point", Map.of("x", 500, "y", 140)), "fh-ws-1", "WLAN"));

        assertTrue(captured.get().contains("\"expect\""), "动作必须带 expect，否则设备侧无从拒绝旧坐标");
        assertTrue(captured.get().contains("fh-ws-1"));
    }

    @Test
    void 动作失败把设备给的原因原样带出() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            String actionId = correlationOf(sent);
            return """
                    {"v":1,"type":"action_result","id":"m-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "actionId":"%s","ok":false,
                      "error":{"code":"STALE_FRAME","msg":"画面已变化，请重新观察"}
                    }}
                    """.formatted(actionId, DEVICE_ID, actionId);
        });

        ActionOutcome outcome = channel.perform(new ActionRequest(
                "a-3", "tap", Map.of("point", Map.of("x", 1, "y", 1)), "fh-stale", null));

        assertFalse(outcome.ok());
        assertEquals("STALE_FRAME", outcome.errorCode());
        assertTrue(outcome.errorMessage().contains("重新观察"), "原因要能被 agent 读懂并据此改变策略");
    }

    @Test
    void 设备不回应时抛可识别异常而不是卡死() {
        WsDeviceChannel channel = newChannel();
        stubSend(invocation -> null);

        assertThrows(DeviceUnavailableException.class, () -> channel.observe(80));
    }

    @Test
    void 重复入站消息被丢弃() {
        WsDeviceChannel channel = newChannel();
        stubSend(invocation -> null);
        WireMessage duplicate = WireMessage.parse(mapper, observeResult("ob-x"));

        assertTrue(channel.handleInbound(duplicate), "首次应接受");
        assertFalse(channel.handleInbound(duplicate), "同一 id 第二次必须丢弃");
    }

    @Test
    void 急停之后拒绝任何动作() {
        WsDeviceChannel channel = newChannel();
        stubSend(invocation -> null);
        properties.setStopAckTimeout(Duration.ofMillis(50));

        channel.stop();

        assertThrows(DeviceUnavailableException.class, () -> channel.observe(80));
        assertThrows(DeviceUnavailableException.class, () -> channel.perform(
                new ActionRequest("a-9", "back", Map.of(), null, null)));
    }

    @Test
    void 急停收到确认时如实返回已停止() {
        WsDeviceChannel channel = newChannel();
        respondOnSend(sent -> {
            WireMessage envelope = WireMessage.parse(mapper, sent);
            // 出站必须带 stop 的 stopId，否则设备无从关联回执
            String stopId = envelope == null ? null : envelope.id();
            return """
                    {"v":1,"type":"stop_ack","id":"m-ack-%s","deviceId":"%s","seq":1,"ts":1,"payload":{
                      "stopId":"%s","pendingCleared":3
                    }}
                    """.formatted(stopId, DEVICE_ID, stopId);
        });

        StopResult result = channel.stop();

        assertTrue(result.acknowledged());
        assertEquals(3, result.pendingCleared());
        assertTrue(result.toPromptText().contains("已确认"));
    }

    /**
     * 最危险的情形不是"没停住"，而是"我们以为停住了"。设备不回确认时必须如实告知。
     */
    @Test
    void 急停未收到确认时必须如实报告未确认() {
        WsDeviceChannel channel = newChannel();
        stubSend(invocation -> null);
        properties.setStopAckTimeout(Duration.ofMillis(50));

        StopResult result = channel.stop();

        assertFalse(result.acknowledged(), "没收到 ack 就不能说停住了");
        assertTrue(result.toPromptText().contains("未确认"));
        assertTrue(result.toPromptText().contains("人工检查"), "要给出下一步动作，而不是一句干巴巴的失败");
    }

    @Test
    void 连接关闭后等待者立即失败() {
        WsDeviceChannel channel = newChannel();

        channel.close("test-close");

        assertFalse(channel.isAlive());
        assertThrows(DeviceUnavailableException.class, () -> channel.observe(80));
    }
}

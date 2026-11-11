package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.device.application.model.DeviceCommand;
import com.summit.dp.device.application.model.DeviceCommandAck;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.device.interfaces.ws.PendingResponses;
import com.summit.dp.device.interfaces.ws.SeqGuard;
import com.summit.dp.device.interfaces.ws.WireMessage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 设备指令在通道层的路由。
 *
 * <p>这些用例不关心"受理与否"的业务判断（那是 handler 的职责），
 * 只锁一件事：**每一条 device_command 都必须换回一条 device_command_ack**。
 * 手机端在等回执，沉默等于让它超时，而超时在用户眼里就是"点了没反应"。</p>
 */
class DeviceCommandRoutingTest {

    private static final String DEVICE_ID = "px7a-cmd";

    private final ObjectMapper mapper = new ObjectMapper();
    private final DevicePayloadMapper payloadMapper = new DevicePayloadMapper(mapper);
    private WebSocketSession session;
    private DeviceWsProperties properties;
    private final List<JsonNode> sent = new ArrayList<>();

    @BeforeEach
    void setUp() {
        session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        when(session.getId()).thenReturn("s-cmd");
        properties = new DeviceWsProperties();
        properties.setTransport("ws");
        stubSend();
    }

    private void stubSend() {
        try {
            doAnswer(invocation -> {
                TextMessage message = invocation.getArgument(0);
                sent.add(mapper.readTree(message.getPayload()));
                return null;
            }).when(session).sendMessage(any());
        } catch (java.io.IOException e) {
            throw new IllegalStateException("装桩失败", e);
        }
    }

    private WsDeviceChannel channel(java.util.function.Supplier<com.summit.dp.device.application.port.DeviceCommandHandler> handler) {
        Device device = new Device(DEVICE_ID, "0.1.0", 33,
                Set.of(DeviceCapability.NODE_TREE),
                new DeviceScreen(1080, 2400, 2.75f, 0),
                System.currentTimeMillis());
        return new WsDeviceChannel(session, mapper, payloadMapper,
                new PendingResponses(), new SeqGuard(), properties, device, handler);
    }

    private WireMessage command(String json) {
        WireMessage wire = WireMessage.parse(mapper, json.replace("__SEQ__", "1"));
        assertNotNull(wire, "测试构造的消息必须能解析");
        return wire;
    }

    private JsonNode onlyAck() {
        List<JsonNode> acks = sent.stream()
                .filter(node -> "device_command_ack".equals(node.path("type").asText()))
                .toList();
        assertEquals(1, acks.size(), "回执条数不对，实际发出: " + sent);
        return acks.get(0);
    }

    @Test
    @DisplayName("① 处理器结论原样回给设备")
    void 受理结论回给设备() {
        AtomicReference<DeviceCommand> seen = new AtomicReference<>();
        DeviceCommandAck ack = DeviceCommandAck.accepted("cmd-1", 12L, null);

        channel(() -> (deviceId, command) -> {
            assertEquals(DEVICE_ID, deviceId);
            seen.set(command);
            return ack;
        }).handleInbound(command("""
                {"v":1,"type":"device_command","id":"m-cmd-1","deviceId":"px7a-cmd","seq":__SEQ__,"ts":1,
                 "payload":{"commandId":"cmd-1","text":"打开无线调试"}}
                """));

        assertNotNull(seen.get());
        assertEquals("打开无线调试", seen.get().text());
        JsonNode payload = onlyAck().path("payload");
        assertEquals("cmd-1", payload.path("commandId").asText());
        assertTrue(payload.path("accepted").asBoolean());
        assertEquals(12, payload.path("sessionId").asInt());
    }

    @Test
    @DisplayName("② 没有处理器时如实回绝，不假装受理")
    void 没有处理器时回绝() {
        channel(() -> null).handleInbound(command("""
                {"v":1,"type":"device_command","id":"m-cmd-2","deviceId":"px7a-cmd","seq":__SEQ__,"ts":1,
                 "payload":{"commandId":"cmd-2","text":"打开无线调试"}}
                """));

        JsonNode payload = onlyAck().path("payload");
        assertFalse(payload.path("accepted").asBoolean());
        assertTrue(payload.path("reason").asText().contains("未装配"), payload.toString());
    }

    @Test
    @DisplayName("③ 畸形指令也要有回执，并且带上能对上的 commandId")
    void 畸形指令也回执() {
        channel(() -> (deviceId, cmd) -> DeviceCommandAck.accepted(cmd.commandId(), 1L, null))
                .handleInbound(command("""
                        {"v":1,"type":"device_command","id":"m-cmd-3","deviceId":"px7a-cmd","seq":__SEQ__,"ts":1,
                         "payload":{"commandId":"cmd-3"}}
                        """));

        JsonNode payload = onlyAck().path("payload");
        assertEquals("cmd-3", payload.path("commandId").asText());
        assertFalse(payload.path("accepted").asBoolean());
        assertTrue(payload.path("reason").asText().contains("格式非法"), payload.toString());
    }

    @Test
    @DisplayName("④ 处理器抛异常也不能打断连接，仍要回执")
    void 处理器异常时回执() {
        channel(() -> (deviceId, cmd) -> {
            throw new IllegalStateException("处理器炸了");
        }).handleInbound(command("""
                {"v":1,"type":"device_command","id":"m-cmd-4","deviceId":"px7a-cmd","seq":__SEQ__,"ts":1,
                 "payload":{"commandId":"cmd-4","text":"打开无线调试"}}
                """));

        JsonNode payload = onlyAck().path("payload");
        assertFalse(payload.path("accepted").asBoolean());
        assertTrue(payload.path("reason").asText().contains("处理器炸了"), payload.toString());
    }
}

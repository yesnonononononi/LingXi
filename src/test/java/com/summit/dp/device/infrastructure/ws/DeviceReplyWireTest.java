package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.device.application.model.DeviceReply;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.device.interfaces.ws.PendingResponses;
import com.summit.dp.device.interfaces.ws.SeqGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 结果回推的报文形状。
 *
 * <p>锁两件事：发出去的必须是 {@code device_reply} 且字段与契约一致（可选字段不能以 null 出现，
 * 设备端 {@code additionalProperties:false} 会整条拒掉）；发送失败只能返回 false，不能把会话执行打断。</p>
 */
class DeviceReplyWireTest {

    private static final String DEVICE_ID = "px7a-wire";

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> sent = new ArrayList<>();
    private WebSocketSession session;
    private DeviceWsProperties properties;

    @BeforeEach
    void setUp() {
        session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        when(session.getId()).thenReturn("s-wire");
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
        } catch (IOException e) {
            throw new IllegalStateException("装桩失败", e);
        }
    }

    private WsDeviceChannel channel() {
        Device device = new Device(DEVICE_ID, "0.1.0", 33,
                Set.of(DeviceCapability.NODE_TREE),
                new DeviceScreen(1080, 2400, 2.75f, 0),
                System.currentTimeMillis());
        return new WsDeviceChannel(session, mapper, new DevicePayloadMapper(mapper),
                new PendingResponses(), new SeqGuard(), properties, device);
    }

    @Test
    @DisplayName("① 最终答复按契约发出，可选字段缺失时不出现 null 字段")
    void 回推报文形状() {
        assertTrue(channel().pushReply(DeviceReply.finalReply(12L, "无线调试已打开", null, 88L)));

        assertEquals(1, sent.size(), "应当只发一条: " + sent);
        JsonNode message = sent.get(0);
        assertEquals("device_reply", message.path("type").asText());
        assertEquals(DEVICE_ID, message.path("deviceId").asText());
        JsonNode payload = message.path("payload");
        assertEquals(12, payload.path("sessionId").asInt());
        assertEquals("final", payload.path("kind").asText());
        assertEquals("无线调试已打开", payload.path("text").asText());
        assertEquals(88, payload.path("turnId").asInt());
        assertFalse(payload.has("commandId"), "空字段不能发出去: " + payload);
    }

    @Test
    @DisplayName("② 发送失败返回 false，不把异常抛给调用方")
    void 发送失败不抛异常() {
        try {
            doThrow(new IOException("连接已断")).when(session).sendMessage(any());
        } catch (IOException e) {
            throw new IllegalStateException("装桩失败", e);
        }

        // 答复丢了不该让会话执行失败，但也不能静默：日志里必须有这一条
        assertFalse(channel().pushReply(DeviceReply.error(12L, "模型超时", null)));
    }
}

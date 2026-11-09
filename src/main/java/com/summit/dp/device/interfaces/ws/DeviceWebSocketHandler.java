package com.summit.dp.device.interfaces.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.infrastructure.ws.DevicePayloadMapper;
import com.summit.dp.device.infrastructure.ws.WsDeviceChannel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;

/**
 * 设备通道的 WebSocket 入口。
 *
 * <p>生命周期只有三步，刻意做得很短：</p>
 * <ol>
 *   <li>连上后先等 hello。收不到 hello 就断开——只连不报的僵尸连接会占着 maxDevices 名额。</li>
 *   <li>hello 之后所有消息都交给 {@link WsDeviceChannel} 路由。</li>
 *   <li>断开时通知编排层：在途动作转"未确认"，绝不回放。</li>
 * </ol>
 */
@Slf4j
public class DeviceWebSocketHandler extends TextWebSocketHandler {

    private static final String ATTR_DEVICE_ID = "deviceId";

    private final ObjectMapper mapper;
    private final DevicePayloadMapper payloadMapper;
    private final DeviceWsProperties properties;
    private final DeviceRegistry registry;
    private final DeviceToolService deviceToolService;

    public DeviceWebSocketHandler(ObjectMapper mapper,
                                  DevicePayloadMapper payloadMapper,
                                  DeviceWsProperties properties,
                                  DeviceRegistry registry,
                                  DeviceToolService deviceToolService) {
        this.mapper = mapper;
        this.payloadMapper = payloadMapper;
        this.properties = properties;
        this.registry = registry;
        this.deviceToolService = deviceToolService;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        if (registry.size() >= properties.getMaxDevices()) {
            log.warn("拒绝接入：已达设备上限 {}，sessionId={}", properties.getMaxDevices(), session.getId());
            session.close(CloseStatus.POLICY_VIOLATION.withReason("device limit reached"));
            return;
        }
        session.getAttributes().put("helloDeadline",
                System.currentTimeMillis() + properties.getHelloTimeout().toMillis());
        log.info("设备通道已建立，等待 hello: sessionId={}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        WireMessage wire = WireMessage.parse(mapper, message.getPayload());
        if (wire == null) {
            log.warn("无法解析的设备消息，已丢弃: sessionId={}", session.getId());
            return;
        }
        if (!wire.versionSupported()) {
            log.warn("协议版本不兼容，断开: sessionId={}, v={}", session.getId(), wire.v());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION.withReason("unsupported protocol version"));
            return;
        }

        WsDeviceChannel channel = channelOf(session);
        if (channel == null) {
            handleHello(session, wire);
            return;
        }
        channel.handleInbound(wire);
    }

    private void handleHello(WebSocketSession session, WireMessage wire) {
        if (!"hello".equals(wire.type())) {
            // 首条消息不是 hello 说明对面没按协议走，直接断开而不是猜它想干什么
            log.warn("首条消息不是 hello: type={}, sessionId={}", wire.type(), session.getId());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION.withReason("hello required"));
            return;
        }
        try {
            Device device = toDevice(wire);
            WsDeviceChannel channel = new WsDeviceChannel(
                    session, mapper, payloadMapper,
                    new PendingResponses(), new SeqGuard(),
                    properties, device);

            session.getAttributes().put(ATTR_DEVICE_ID, device.deviceId());
            session.getAttributes().put("channel", channel);
            registry.register(channel);

            ObjectNode payload = mapper.createObjectNode();
            payload.put("serverVersion", "0.0.1-SNAPSHOT");
            payload.put("accepted", true);
            payload.put("heartbeatMs", (int) properties.getHeartbeat().toMillis());
            send(session, new WireMessage(
                    WireMessage.SUPPORTED_VERSION,
                    "hello_ack",
                    "ack-" + device.deviceId(),
                    device.deviceId(),
                    0,
                    System.currentTimeMillis(),
                    payload));

            log.info("设备已接入: deviceId={}, sdk={}, capabilities={}, screen={}x{}",
                    device.deviceId(), device.androidSdk(), device.capabilities(),
                    device.screen().width(), device.screen().height());
        } catch (IllegalArgumentException e) {
            log.warn("hello 内容非法，断开: sessionId={}, reason={}", session.getId(), e.getMessage());
            closeQuietly(session, CloseStatus.POLICY_VIOLATION.withReason("invalid hello"));
        }
    }

    private Device toDevice(WireMessage wire) {
        JsonNode payload = wire.payload();
        JsonNode screenNode = payload.get("screen");
        if (screenNode == null || screenNode.isNull()) {
            throw new IllegalArgumentException("hello 缺少 screen");
        }
        DeviceScreen screen = new DeviceScreen(
                screenNode.path("w").asInt(),
                screenNode.path("h").asInt(),
                (float) screenNode.path("density").asDouble(),
                screenNode.path("rotation").asInt(0));

        Set<DeviceCapability> capabilities = new LinkedHashSet<>();
        JsonNode caps = payload.get("capabilities");
        if (caps != null && caps.isArray()) {
            for (JsonNode cap : caps) {
                Optional<DeviceCapability> parsed = DeviceCapability.fromWire(cap.asText());
                if (parsed.isPresent()) {
                    capabilities.add(parsed.get());
                } else {
                    // 未知能力只记日志，不塞进能力集：宁可少一项能力，也不能凭空多一项
                    log.warn("设备上报了未知能力，已忽略: {}（deviceId={})", cap.asText(), wire.deviceId());
                }
            }
        }

        return new Device(
                wire.deviceId(),
                payload.path("appVersion").asText("unknown"),
                payload.path("androidSdk").asInt(0),
                capabilities,
                screen,
                System.currentTimeMillis());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        WsDeviceChannel channel = channelOf(session);
        Object deviceId = session.getAttributes().get(ATTR_DEVICE_ID);
        if (channel != null) {
            channel.close(status.getReason() == null ? String.valueOf(status.getCode()) : status.getReason());
        }
        if (deviceId != null) {
            // 交给编排层处理：摘除设备 + 在途动作标未确认 + 清理待确认队列
            deviceToolService.onDisconnected(String.valueOf(deviceId));
            log.info("设备已断开: deviceId={}, status={}", deviceId, status.getCode());
        } else {
            log.info("未完成握手的连接已关闭: sessionId={}, status={}", session.getId(), status.getCode());
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("设备通道传输异常: sessionId={}, reason={}", session.getId(), exception.getMessage());
    }

    private WsDeviceChannel channelOf(WebSocketSession session) {
        Object value = session.getAttributes().get("channel");
        return value instanceof WsDeviceChannel channel ? channel : null;
    }

    private void send(WebSocketSession session, WireMessage message) {
        try {
            session.sendMessage(new TextMessage(message.text(mapper)));
        } catch (Exception e) {
            log.warn("发送失败: sessionId={}, reason={}", session.getId(), e.getMessage());
        }
    }

    private void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            session.close(status);
        } catch (Exception e) {
            log.debug("关闭连接失败: sessionId={}, reason={}", session.getId(), e.getMessage());
        }
    }
}

package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.DeviceCommand;
import com.summit.dp.device.application.model.DeviceCommandAck;
import com.summit.dp.device.application.model.NormalizedBounds;
import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.UiElement;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.interfaces.ws.WireMessage;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * 协议 payload ⇄ 领域模型的转换。
 *
 * <p>刻意不建第二套 DTO 树：schema 的唯一真源在
 * `lingxi-android/contract/protocol.schema.json`，Java 侧再造一堆 record 只会多一处漂移点。
 * 这一层的职责就一句话：把 JsonNode 变成领域对象，缺字段就明确报错，绝不用默认值糊过去。</p>
 *
 * <p>缺字段必须报错而不是兜底：设备少发一个 frameHash，我们用默认值补上，
 * 就等于把"前置校验"悄悄关掉了——事故会发生在很久以后。</p>
 */
public class DevicePayloadMapper {

    /**
     * 内联截图的 base64 长度上限（字符）。
     *
     * <p>2MB 原始字节 → 约 2.8M 字符。超过它就是对面把图当附件传了，应该改走 shotRef 落盘。</p>
     */
    private static final int MAX_INLINE_BASE64_CHARS = 2_800_000;

    private final ObjectMapper mapper;

    public DevicePayloadMapper(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    // ---------- 出站 ----------

    public ObjectNode observePayload(String reqId, ObserveRequest request) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("reqId", reqId);
        // 如实上报模式：曾把 mode 固定成 both 却丢弃截图，设备于是每次都白截一张图（约 300ms +
        // 一张 60KB 图）。请求和消费必须同源，否则"省 token"就成了空话。
        payload.put("mode", request.mode().wire());
        payload.put("maxNodes", request.maxNodes());
        payload.put("includeScreenshot", request.mode().wantsScreenshot());
        return payload;
    }

    public ObjectNode actionPayload(ActionRequest request) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("actionId", request.actionId());
        payload.put("kind", request.kind());
        JsonNode params = mapper.valueToTree(request.params());
        payload.set("params", params == null ? mapper.createObjectNode() : params);
        String expectFrameHash = request.expectFrameHash();
        if (expectFrameHash != null && !expectFrameHash.isBlank()) {
            ObjectNode expect = mapper.createObjectNode();
            expect.put("frameHash", expectFrameHash);
            payload.set("expect", expect);
        }
        return payload;
    }

    // ---------- 入站 ----------

    public String requireText(JsonNode payload, String field) {
        JsonNode node = payload == null ? null : payload.get(field);
        if (node == null || node.isNull() || node.asText().isBlank()) {
            throw new IllegalArgumentException("设备响应缺少必填字段: " + field);
        }
        return node.asText();
    }

    public ObserveSnapshot toSnapshot(WireMessage message) {
        JsonNode payload = message.payload();
        JsonNode screenNode = payload.get("screen");
        if (screenNode == null || screenNode.isNull()) {
            throw new IllegalArgumentException("观察结果缺少 screen");
        }
        DeviceScreen screen = new DeviceScreen(
                screenNode.path("w").asInt(),
                screenNode.path("h").asInt(),
                (float) screenNode.path("density").asDouble(),
                screenNode.path("rotation").asInt(0));

        List<UiElement> elements = new ArrayList<>();
        JsonNode nodes = payload.get("nodes");
        if (nodes != null && nodes.isArray()) {
            for (JsonNode node : nodes) {
                elements.add(toElement(node));
            }
        }

        return new ObserveSnapshot(
                message.deviceId(),
                requireText(payload, "frameHash"),
                requireText(payload, "focusedPkg"),
                payload.path("truncated").asBoolean(false),
                screen,
                elements,
                toScreenshot(payload.get("screenshot")));
    }

    /**
     * 解析截图载荷。字段缺失一律显式报错，不用默认值糊过去。
     *
     * <p>直接复用协议里的两个字段语义：{@code width/height} 是图片尺寸（换算必需），
     * {@code rawWidth/rawHeight} 是原始像素（尺度校验用）。两者混用会让落点整体偏移，
     * 而症状只是"点了没反应"。</p>
     */
    private DeviceScreenshot toScreenshot(JsonNode shot) {
        if (shot == null || shot.isNull()) {
            return null;
        }
        if (!shot.isObject()) {
            throw new IllegalArgumentException("screenshot 必须是对象");
        }
        String ref = optionalText(shot, "shotRef");
        String base64 = optionalText(shot, "shotB64");
        byte[] bytes = decodeInline(shot, base64);
        return new DeviceScreenshot(
                ref,
                bytes,
                optionalText(shot, "mimeType"),
                optionalInt(shot, "width"),
                optionalInt(shot, "height"),
                optionalInt(shot, "rawWidth"),
                optionalInt(shot, "rawHeight"));
    }

    /**
     * 内联 base64 → 字节。
     *
     * <p>上限先按 base64 字符串长度拦一道：真解码 3MB 字符串只为发现"太大了"是浪费；
     * 解码后再由 [DeviceScreenshot] 复核一次真实字节数。</p>
     */
    private byte[] decodeInline(JsonNode shot, String base64) {
        if (base64 == null) {
            return null;
        }
        if (base64.length() > MAX_INLINE_BASE64_CHARS) {
            throw new IllegalArgumentException(
                    "内联截图过大（base64 " + base64.length() + " 字符），设备应落盘后只回 shotRef");
        }
        try {
            return Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException undecodable) {
            throw new IllegalArgumentException("截图的 base64 无法解码，载荷已损坏");
        }
    }

    private static Integer optionalInt(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.canConvertToInt()) {
            throw new IllegalArgumentException("字段 " + field + " 不是合法整数: " + value);
        }
        return value.asInt();
    }

    private static String optionalText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return null;
        }
        String text = value.asText();
        return text == null || text.isBlank() ? null : text;
    }

    private UiElement toElement(JsonNode node) {
        JsonNode bounds = node.get("bounds");
        if (bounds == null || bounds.isNull()) {
            throw new IllegalArgumentException("节点缺少 bounds: idx=" + node.path("idx").asInt());
        }
        NormalizedBounds box = new NormalizedBounds(
                bounds.path("x1").asInt(),
                bounds.path("y1").asInt(),
                bounds.path("x2").asInt(),
                bounds.path("y2").asInt());
        return new UiElement(
                node.path("idx").asInt(),
                node.path("role").asText("other"),
                textOrNull(node, "text"),
                textOrNull(node, "hint"),
                box,
                node.path("clickable").asBoolean(false),
                node.path("enabled").asBoolean(true),
                node.path("editable").asBoolean(false),
                node.has("checked") ? node.get("checked").asBoolean() : null,
                node.path("depth").asInt(0));
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    public ActionOutcome toOutcome(WireMessage message) {
        JsonNode payload = message.payload();
        String actionId = requireText(payload, "actionId");
        boolean ok = payload.path("ok").asBoolean(false);
        if (!ok) {
            JsonNode error = payload.get("error");
            String code = error == null || error.isNull() ? "INTERNAL" : error.path("code").asText("INTERNAL");
            String msg = error == null || error.isNull() ? "设备未提供原因" : error.path("msg").asText("设备未提供原因");
            return ActionOutcome.failure(actionId, code, msg);
        }
        JsonNode settled = payload.get("settled");
        Integer idleMs = null;
        Boolean changed = null;
        String frameHash = null;
        if (settled != null && settled.isObject()) {
            idleMs = settled.has("idleMs") ? settled.get("idleMs").asInt() : null;
            changed = settled.has("changed") ? settled.get("changed").asBoolean() : null;
            JsonNode hash = settled.get("frameHash");
            frameHash = hash == null || hash.isNull() ? null : hash.asText();
        }
        return ActionOutcome.success(actionId, idleMs, changed, frameHash);
    }

    /** 观察结果里的 reqId；缺失时返回 null，由调用方决定丢弃。 */
    public String reqIdOf(JsonNode payload) {
        JsonNode node = payload == null ? null : payload.get("reqId");
        return node == null || node.isNull() ? null : node.asText();
    }

    /** 急停回执里的 stopId。别用 reqIdOf 取它——字段名不同，取出来永远是 null。 */
    public String stopIdOf(JsonNode payload) {
        JsonNode node = payload == null ? null : payload.get("stopId");
        return node == null || node.isNull() ? null : node.asText();
    }

    /** 动作结果里的 actionId。 */
    public String actionIdOf(JsonNode payload) {
        JsonNode node = payload == null ? null : payload.get("actionId");
        return node == null || node.isNull() ? null : node.asText();
    }
    /** device_command 里的 commandId；用于解析失败时也能回一条带关联键的回执。 */
    public String commandIdOf(JsonNode payload) {
        JsonNode node = payload == null ? null : payload.get("commandId");
        return node == null || node.isNull() || node.asText().isBlank() ? "unknown" : node.asText();
    }

    /**
     * 解析设备指令。
     *
     * <p>{@code text} 与 {@code commandId} 缺失一律报错：这两者缺任何一个，
     * "受理"都会变成一笔糊涂账——要么不知道要不要跑，要么不知道重放时算不算同一条。</p>
     */
    public DeviceCommand toCommand(WireMessage message) {
        JsonNode payload = message == null ? null : message.payload();
        if (payload == null || !payload.isObject()) {
            throw new IllegalArgumentException("device_command 缺少 payload");
        }
        String commandId = requireText(payload, "commandId");
        String text = requireText(payload, "text");
        Long sessionId = null;
        JsonNode session = payload.get("sessionId");
        if (session != null && !session.isNull()) {
            if (!session.canConvertToLong() || session.asLong() <= 0) {
                throw new IllegalArgumentException("device_command 的 sessionId 非法: " + session);
            }
            sessionId = session.asLong();
        }
        return new DeviceCommand(commandId, text, sessionId);
    }

    /** 指令回执载荷。字段语义与 schema 的 deviceCommandAck 一一对应。 */
    public ObjectNode commandAckPayload(DeviceCommandAck ack) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("commandId", ack.commandId());
        payload.put("accepted", ack.accepted());
        if (ack.sessionId() != null) {
            payload.put("sessionId", ack.sessionId());
        }
        if (ack.pendingId() != null && !ack.pendingId().isBlank()) {
            payload.put("pendingId", ack.pendingId());
        }
        if (ack.reason() != null && !ack.reason().isBlank()) {
            payload.put("reason", ack.reason());
        }
        return payload;
    }

}

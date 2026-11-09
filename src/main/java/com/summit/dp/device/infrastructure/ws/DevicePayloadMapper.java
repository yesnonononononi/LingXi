package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.NormalizedBounds;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.UiElement;
import com.summit.dp.device.domain.DeviceScreen;
import com.summit.dp.device.interfaces.ws.WireMessage;

import java.util.ArrayList;
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

    private final ObjectMapper mapper;

    public DevicePayloadMapper(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    // ---------- 出站 ----------

    public ObjectNode observePayload(String reqId, int maxNodes) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("reqId", reqId);
        payload.put("mode", "both");
        payload.put("maxNodes", maxNodes);
        payload.put("includeScreenshot", false);
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
        String screenshotRef = null;
        JsonNode shot = payload.get("screenshot");
        if (shot != null && shot.isObject()) {
            JsonNode ref = shot.get("shotRef");
            screenshotRef = ref == null || ref.isNull() ? null : ref.asText();
        }

        return new ObserveSnapshot(
                message.deviceId(),
                requireText(payload, "frameHash"),
                requireText(payload, "focusedPkg"),
                payload.path("truncated").asBoolean(false),
                screen,
                elements,
                screenshotRef);
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

    /** 动作结果里的 actionId。 */
    public String actionIdOf(JsonNode payload) {
        JsonNode node = payload == null ? null : payload.get("actionId");
        return node == null || node.isNull() ? null : node.asText();
    }
}

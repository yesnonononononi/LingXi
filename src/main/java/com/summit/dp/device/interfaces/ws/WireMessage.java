package com.summit.dp.device.interfaces.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;

/**
 * 线上消息（信封）。
 *
 * <p>只做信封层，payload 留给 {@link JsonNode}：协议里 12 类消息各有各的 payload，
 * 为它们建 12 个 record 会把这一层变成第二个 schema；而 schema 的唯一真源在
 * `lingxi-android/contract/protocol.schema.json`。Java 侧按需读取字段，比"多一套模型"
 * 少一处漂移点。</p>
 *
 * <p>但仍要看 <b>type</b> 再解 payload：不判断类型就按字段名硬取，等于假设对面没改协议。</p>
 */
public record WireMessage(
        int v,
        String type,
        String id,
        String deviceId,
        long seq,
        long ts,
        JsonNode payload
) {

    public static final int SUPPORTED_VERSION = 1;

    /** 解码失败返回 null 而不是抛异常：一条畸形消息不该把整条连接打死。 */
    public static WireMessage parse(ObjectMapper mapper, String text) {
        try {
            JsonNode root = mapper.readTree(text);
            if (root == null || !root.isObject()) {
                return null;
            }
            JsonNode type = root.get("type");
            JsonNode id = root.get("id");
            JsonNode deviceId = root.get("deviceId");
            if (type == null || type.isNull() || id == null || id.isNull()
                    || deviceId == null || deviceId.isNull()) {
                return null;
            }
            JsonNode payload = root.get("payload");
            return new WireMessage(
                    root.path("v").asInt(SUPPORTED_VERSION),
                    type.asText(),
                    id.asText(),
                    deviceId.asText(),
                    root.path("seq").asLong(0),
                    root.path("ts").asLong(0),
                    payload == null || payload.isNull() ? mapper.createObjectNode() : payload);
        } catch (IOException e) {
            return null;
        }
    }

    /** 协议大版本不匹配：对面可能是不兼容的新版本，只能明确拒绝，不能猜着往下走。 */
    public boolean versionSupported() {
        return v == SUPPORTED_VERSION;
    }

    public String text(ObjectMapper mapper) {
        ObjectNode root = mapper.createObjectNode();
        root.put("v", v);
        root.put("type", type);
        root.put("id", id);
        root.put("deviceId", deviceId);
        root.put("seq", seq);
        root.put("ts", ts);
        root.set("payload", payload == null ? mapper.createObjectNode() : payload);
        try {
            return mapper.writeValueAsString(root);
        } catch (IOException e) {
            throw new IllegalStateException("消息序列化失败: " + e.getMessage(), e);
        }
    }
}

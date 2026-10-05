package com.summit.dp.stream.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.protocol.StreamOperation;
import java.util.ArrayList;
import java.util.List;

/** 校准使用实体自身的归属，不能把子会话数据误标为根会话。 */
public final class StreamCalibrationOperations {
    private final ObjectMapper json;
    public StreamCalibrationOperations(ObjectMapper json) { this.json = json; }
    public List<StreamOperation> build(long rootId, StreamSnapshotAssembler.Base base) {
        List<StreamOperation> result = new ArrayList<>();
        List<Section> sections = List.of(
                new Section(base.sessions(), StreamEventType.SESSION_UPDATED.wireValue(), "session", "id"),
                new Section(base.turns(), StreamEventType.TURN_UPDATED.wireValue(), "turn", "sessionId"),
                new Section(base.executions(), StreamEventType.EXECUTION_UPDATED.wireValue(), "execution", "id"),
                new Section(base.tools(), StreamEventType.TOOL_CALL_UPDATED.wireValue(), "toolCall", "conversationId"),
                new Section(base.messages(), StreamEventType.MESSAGE_COMMITTED.wireValue(), "message", "sessionId"));
        for (Section section : sections) {
            for (ObjectNode value : section.values()) {
                String sessionId = resolveSessionId(section, value, rootId);
                String executionId = section.ownIdProperty() == null
                        ? value.path("executionId").asText(null) : null;
                result.add(StreamOperation.create(sessionId, value.path("turnId").asText(null), executionId,
                        String.valueOf(base.revision()), section.type(),
                        json.createObjectNode().set(section.property(), value)));
            }
        }
        return result;
    }

    /**
     * 解析实体归属的根侧会话键。
     *
     * <p>会话与执行以自身 id 为归属（它们的 id 就是会话键）；轮次、消息、工具调用挂在
     * {@code sessionId} 上，而工具调用在委派场景下用 {@code conversationId}。
     * 三种口径都取不到时兜底到根会话本身，保证校准帧不会因为缺归属而丢投递。</p>
     */
    private String resolveSessionId(Section section, ObjectNode value, long rootId) {
        if (section.ownIdProperty() != null) {
            return value.path(section.ownIdProperty()).asText();
        }
        return value.path("sessionId").asText(
                value.path("conversationId").asText(String.valueOf(rootId)));
    }

    /**
     * 一类待校准实体。
     *
     * @param ownIdProperty 该实体以自身哪个字段作为归属；{@code null} 表示归属在 sessionId 上
     */
    private record Section(List<ObjectNode> values, String type, String property, String ownIdProperty) { }
}

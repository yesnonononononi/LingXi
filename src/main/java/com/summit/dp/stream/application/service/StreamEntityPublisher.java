package com.summit.dp.stream.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.protocol.StreamOperation;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** 归属只按实体自己的会话解析，缺失实体通知由重连校准。 */
@Service
@RequiredArgsConstructor
public class StreamEntityPublisher {
    private final ExecutionIdentity executionIdentity;
    private final SessionStreamHub hub;
    private final ObjectMapper json;
    public void publish(Long sessionId, Long turnId, Long executionId, String type, String property, ObjectNode view) {
        // 会话查不到即静默跳过：实体通知是旁路，缺失由重连校准补齐，不该让主链路失败。
        Long rootId = executionIdentity.resolveRootSessionIdOrNull(sessionId);
        if (rootId == null) return;
        ObjectNode payload = json.createObjectNode().set(property, view);
        hub.publish(rootId, StreamOperation.create(String.valueOf(sessionId),
                turnId == null ? null : String.valueOf(turnId), executionId == null ? null : String.valueOf(executionId),
                null, type, payload));
    }
    public void history(long rootId, ObjectNode payload) {
        hub.publish(rootId, StreamOperation.create(String.valueOf(rootId), null, null, null,
                StreamEventType.HISTORY_INVALIDATED.wireValue(), payload));
    }
}

package com.summit.dp.stream.application.projection;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.protocol.StreamOperation;
import org.springframework.stereotype.Component;
import java.util.Map;
import java.util.List;

/** 持久化字段按版本合并，可操作动作按投影顺序独立刷新。 */
@Component
public class StreamProjectionReducer {

/** 去重身份只保留最近窗口，避免长会话持续占用内存。 */
    private static final int DEDUPE_WINDOW_SIZE = 4096;

    public boolean apply(RootProjection root, StreamOperation operation) {
        if (root.appliedIds.contains(operation.eventId())) return false;
        if (operation.historyRevision() != null && Long.parseLong(operation.historyRevision()) < root.historyRevision) return false;
        if (root.invalidTurns.contains(operation.turnId()) || root.invalidExecutions.contains(operation.executionId())) return false;
        JsonNode payload = operation.payload();
        boolean changed = switch (StreamEventType.fromWireValue(operation.type())) {
            case SESSION_UPDATED -> merge(root.sessions, payload.get("session"), "id", false);
            case TURN_UPDATED -> merge(root.turns, payload.get("turn"), "turnId", false);
            case EXECUTION_UPDATED -> merge(root.executions, payload.get("execution"), "id", false);
            case TOOL_CALL_UPDATED -> merge(root.tools, payload.get("toolCall"), "id", true);
            case TEXT_DELTA, THINKING_DELTA, MESSAGE_FINALIZED, MESSAGE_COMMITTED -> mergeMessage(root, operation);
            case HISTORY_INVALIDATED -> { invalidate(root, payload); yield true; }
            case null, default -> true;
        };
        root.appliedIds.add(operation.eventId());
        while (root.appliedIds.size() > DEDUPE_WINDOW_SIZE) {
            String oldest = root.appliedIds.iterator().next();
            root.appliedIds.remove(oldest);
        }
        return changed;
    }

    public boolean merge(Map<String, ObjectNode> target, JsonNode incoming, String idKey, boolean derived) {
        if (incoming == null || !incoming.isObject() || !incoming.hasNonNull(idKey)) return false;
        String id = incoming.path(idKey).asText();
        ObjectNode previous = target.get(id);
        if (previous != null && incoming.hasNonNull("version") && previous.hasNonNull("version")
                && Long.parseLong(incoming.path("version").asText()) < Long.parseLong(previous.path("version").asText())) {
            return false;
        }
        ObjectNode next = incoming.deepCopy();
        if (previous != null && incoming.hasNonNull("version") && previous.hasNonNull("version")
                && incoming.path("version").asText().equals(previous.path("version").asText())) {
            ObjectNode oldData = previous.deepCopy();
            ObjectNode newData = next.deepCopy();
            if (derived) {
                for (String key : List.of("allowedActions", "unavailableReason", "projectionStamp", "executionVersion")) {
                    oldData.remove(key); newData.remove(key);
                }
            }
            if (!oldData.equals(newData)) throw new IllegalStateException("实体同版本内容冲突，请重新同步状态");
            if (!derived || previous.equals(next)) return false;
        }
        target.put(id, next);
        return true;
    }

    private boolean mergeMessage(RootProjection root, StreamOperation operation) {
        JsonNode message = operation.payload().path("message");
        if (!(message instanceof ObjectNode value)) return false;
        String key = value.path("streamKey").asText();
        if (key.isEmpty()) return false;
        ObjectNode previous = root.messages.get(key);
        boolean committed = StreamEventType.MESSAGE_COMMITTED.wireValue().equals(operation.type());
        if (previous != null && committed && previous.path("committed").asBoolean()
                && previous.path("id").equals(value.path("id"))) return false;
        if (previous != null && !committed && previous.path("blockVersion").asLong() > value.path("blockVersion").asLong(1)) return false;
        ObjectNode next = value.deepCopy();
        if (previous != null && committed) {
            boolean changedText = !previous.path("text").equals(value.path("text"))
                    || !previous.path("thinking").asText("").equals(value.path("thinking").asText(""));
            next.put("blockVersion", String.valueOf(previous.path("blockVersion").asLong() + (changedText ? 1 : 0)));
            if (previous.hasNonNull("executionId")) next.set("executionId", previous.get("executionId"));
        }
        if (previous != null && previous.hasNonNull("id") && !next.hasNonNull("id")) next.set("id", previous.get("id"));
        if (previous != null && previous.path("committed").asBoolean()) next.put("committed", true);
        next.put("sessionId", operation.sessionId());
        if (operation.turnId() != null) next.put("turnId", operation.turnId());
        if (operation.executionId() != null) next.put("executionId", operation.executionId());
        root.messages.put(key, next);
        return true;
    }

    private void invalidate(RootProjection root, JsonNode payload) {
        long revision = Long.parseLong(payload.path("historyRevision").asText());
        if (revision <= root.historyRevision) return;
        root.historyRevision = revision;
        if (payload.path("clearHistory").asBoolean()) {
            root.messages.clear(); root.tools.clear(); root.turns.clear(); root.executions.clear();
        }
        payload.path("turnIds").forEach(id -> root.invalidTurns.add(id.asText()));
        payload.path("executionIds").forEach(id -> root.invalidExecutions.add(id.asText()));
        root.turns.keySet().removeAll(root.invalidTurns);
        root.executions.keySet().removeAll(root.invalidExecutions);
        root.messages.values().removeIf(value -> root.invalidTurns.contains(value.path("turnId").asText())
                || root.invalidExecutions.contains(value.path("executionId").asText()));
        root.tools.values().removeIf(value -> root.invalidExecutions.contains(value.path("executionId").asText()));
    }
}

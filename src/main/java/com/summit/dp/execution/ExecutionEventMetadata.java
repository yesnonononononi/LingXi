package com.summit.dp.execution;

import java.util.HashMap;
import java.util.Map;

/** Explicit business identifiers allowed to travel with framework events. */
public final class ExecutionEventMetadata {
    public static final String SESSION_ID = "sessionId";
    public static final String TURN_ID = "turnId";
    public static final String PARENT_TURN_ID = "parentTurnId";

    private ExecutionEventMetadata() {
    }

    public static Map<String, Object> of(long sessionId, Long turnId, Long parentTurnId) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put(SESSION_ID, Long.toString(sessionId));
        if (turnId != null) {
            metadata.put(TURN_ID, turnId.toString());
        }
        if (parentTurnId != null) {
            metadata.put(PARENT_TURN_ID, parentTurnId.toString());
        }
        return Map.copyOf(metadata);
    }

    public static Long turnId(Map<String, Object> metadata) {
        return ExecutionAttributes.readLong(metadata, TURN_ID);
    }
}

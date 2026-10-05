package com.summit.dp.stream.application.protocol;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

/** 顺序只在同一投影代际内有效，不提供逐事件回放。 */
public record StreamEventEnvelope(int schemaVersion, String eventId, String streamEpoch, String seq,
                                  String rootSessionId, String sessionId, String turnId, String executionId,
                                  String historyRevision, String type, Instant timestamp, JsonNode payload) { }

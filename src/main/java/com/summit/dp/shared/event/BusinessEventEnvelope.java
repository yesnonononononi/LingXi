package com.summit.dp.shared.event;

import java.io.Serializable;
import java.time.Instant;

/** Transport-agnostic envelope of a pushed business event. */
public record BusinessEventEnvelope<T>(
        String type,
        String executionId,
        Serializable sessionId,
        Instant timestamp,
        T data
) {
}

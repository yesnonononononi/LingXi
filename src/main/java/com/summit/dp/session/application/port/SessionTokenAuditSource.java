package com.summit.dp.session.application.port;

import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.core.compact.ContextUsageMetric;

import java.time.Instant;
import java.util.Optional;

/** 从会话已提交的执行检查点重新采集审计。 */
public interface SessionTokenAuditSource {
    Optional<Snapshot> refresh(Long sessionId);

    record Snapshot(Long executionId, Instant capturedAt, TokenAuditDocument document, ContextUsageMetric usage) {}
}

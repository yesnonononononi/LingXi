package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.audit.TokenAuditor;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.session.application.port.SessionTokenAuditSource;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Optional;

/** 读取独立的检查点，避免在执行线程更新消息时扫描同一份上下文。 */
@Component
@RequiredArgsConstructor
public class ExecutionTokenAuditSource implements SessionTokenAuditSource {
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executions;
    private final ExecutionRepository checkpoints;
    private final TokenAuditor auditor;

    @Override
    public Optional<Snapshot> refresh(Long sessionId) {
        // 在读取检查点前确定采集时间，避免慢速重算覆盖随后到达的终态采集。
        Instant capturedAt = Instant.now();
        return executions.findRecentBySession(sessionId, 1).stream().findFirst()
                .flatMap(row -> checkpoints.findById(row.getId().toString())
                        .filter(execution -> execution.getMessages() != null && !execution.getMessages().isEmpty())
                        .map(execution -> audit(row.getId(), capturedAt, execution)));
    }

    private Snapshot audit(Long executionId, Instant capturedAt, Execution execution) {
        return new Snapshot(executionId, capturedAt, auditor.analysis(execution), execution.getContextUsageMetric());
    }
}

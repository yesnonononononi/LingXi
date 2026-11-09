package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.audit.TokenAuditor;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.session.application.port.SessionTokenAuditSource;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

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
        return executions.findRecentBySession(sessionId, 1).stream().findFirst()
                .flatMap(execution -> checkpoints.findById(execution.getId().toString()))
                .filter(execution -> execution.getMessages() != null && !execution.getMessages().isEmpty())
                .map(this::audit);
    }

    private Snapshot audit(Execution execution) {
        return new Snapshot(auditor.analysis(execution), execution.getContextUsageMetric());
    }
}

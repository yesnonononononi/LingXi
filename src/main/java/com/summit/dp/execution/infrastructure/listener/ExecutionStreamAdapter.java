package com.summit.dp.execution.infrastructure.listener;

import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.service.StreamClientViewAssembler;
import com.summit.dp.stream.application.service.StreamEntityPublisher;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import com.summit.dp.shared.event.CommittedStateObserver;
import org.springframework.stereotype.Component;
import java.util.List;

@Component
@RequiredArgsConstructor
public class ExecutionStreamAdapter implements CommittedStateObserver {
    private final ExecutionRepository executions;
    private final ChatTurnRepository turns;
    private final StreamClientViewAssembler views;
    private final StreamEntityPublisher publisher;
    @Override
    public void changed(CommittedStateChange change) {
        if (change.kind() != CommittedStateChange.Kind.EXECUTION) return;
        executions.findSummariesByIds(List.of(Long.valueOf(change.id()))).forEach(execution -> publisher.publish(
                execution.getSessionId(), turns.findByExecutionId(execution.getId()).map(turn -> turn.getId()).orElse(null),
                execution.getId(), StreamEventType.EXECUTION_UPDATED.wireValue(), "execution", views.execution(execution)));
    }
}

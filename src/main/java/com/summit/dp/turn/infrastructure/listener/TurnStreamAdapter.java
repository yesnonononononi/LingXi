package com.summit.dp.turn.infrastructure.listener;

import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.stream.application.service.StreamClientViewAssembler;
import com.summit.dp.stream.application.service.StreamEntityPublisher;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import com.summit.dp.shared.event.CommittedStateObserver;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class TurnStreamAdapter implements CommittedStateObserver {
    private final ChatTurnRepository turns;
    private final StreamClientViewAssembler views;
    private final StreamEntityPublisher publisher;
    @Override
    public void changed(CommittedStateChange change) {
        if (change.kind() != CommittedStateChange.Kind.TURN) return;
        turns.findById(Long.valueOf(change.id())).ifPresent(turn -> publisher.publish(turn.getSessionId(),
                turn.getId(), turn.getExecutionId(), StreamEventType.TURN_UPDATED.wireValue(), "turn", views.turn(turn)));
    }
}

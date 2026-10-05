package com.summit.dp.session.infrastructure.listener;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.service.StreamClientViewAssembler;
import com.summit.dp.stream.application.service.StreamEntityPublisher;
import lombok.RequiredArgsConstructor;
import com.summit.dp.shared.event.CommittedStateObserver;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class SessionStreamAdapter implements CommittedStateObserver {
    private final SessionRepository sessions;
    private final StreamClientViewAssembler views;
    private final StreamEntityPublisher publisher;
    private final ObjectMapper json;
    @Override
    public void changed(CommittedStateChange change) {
        if (change.kind() == CommittedStateChange.Kind.SESSION) sessions.findById(Long.valueOf(change.id()))
                .ifPresent(session -> publisher.publish(session.getId(), null, null,
                        StreamEventType.SESSION_UPDATED.wireValue(), "session", views.session(session)));
        if (change.kind() == CommittedStateChange.Kind.HISTORY) {
            ObjectNode payload = json.createObjectNode();
            payload.put("historyRevision", String.valueOf(change.historyRevision()));
            payload.set("turnIds", json.valueToTree(change.turnIds()));
            payload.set("executionIds", json.valueToTree(change.executionIds()));
            publisher.history(change.sessionId(), payload);
        }
    }
}

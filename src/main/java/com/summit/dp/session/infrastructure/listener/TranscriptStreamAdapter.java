package com.summit.dp.session.infrastructure.listener;

import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.service.StreamClientViewAssembler;
import com.summit.dp.stream.application.service.StreamEntityPublisher;
import com.summit.dp.stream.application.protocol.StreamEventType;
import lombok.RequiredArgsConstructor;
import com.summit.dp.shared.event.CommittedStateObserver;
import org.springframework.stereotype.Component;

/** SYSTEM 行不进入用户投影，接纳消息沿用 streamKey 原地绑定。 */
@Component
@RequiredArgsConstructor
public class TranscriptStreamAdapter implements CommittedStateObserver {
    private final MessageRepository messages;
    private final StreamClientViewAssembler views;
    private final StreamEntityPublisher publisher;
    @Override
    public void changed(CommittedStateChange change) {
        if (change.kind() != CommittedStateChange.Kind.MESSAGE) return;
        messages.findById(Long.valueOf(change.id())).filter(message -> message.getType() != SessionMessageType.SYSTEM)
                .ifPresent(message -> publisher.publish(message.getSessionId(), message.getTurnId(), null,
                        StreamEventType.MESSAGE_COMMITTED.wireValue(), "message", views.message(message)));
    }
}

package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.stream.application.protocol.StreamEventType;
import com.summit.dp.stream.application.service.StreamClientViewAssembler;
import com.summit.dp.stream.application.service.StreamEntityPublisher;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import com.summit.dp.shared.event.CommittedStateObserver;
import org.springframework.stereotype.Component;

/** 执行可用性变化也要刷新动作集合，即使工具持久化版本未变化。 */
@Component
@RequiredArgsConstructor
public class ToolCallStreamAdapter implements CommittedStateObserver {
    private final ToolCallRepository tools;
    private final ChatTurnRepository turns;
    private final StreamClientViewAssembler views;
    private final StreamEntityPublisher publisher;
    @Override
    public void changed(CommittedStateChange change) {
        if (change.kind() == CommittedStateChange.Kind.TOOL) tools.findById(change.id()).ifPresent(this::publish);
        if (change.kind() == CommittedStateChange.Kind.EXECUTION) {
            tools.listUnresolvedByExecutionId(Long.valueOf(change.id())).forEach(this::publish);
        }
    }
    public void publish(ToolCall tool) {
        Long turnId = turns.findByExecutionId(tool.getExecutionId()).map(turn -> turn.getId()).orElse(null);
        publisher.publish(tool.getConversationId(), turnId, tool.getExecutionId(),
                StreamEventType.TOOL_CALL_UPDATED.wireValue(), "toolCall", views.tool(tool));
    }
}

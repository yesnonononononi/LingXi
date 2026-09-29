package com.summit.dp.session.infrastructure.transcript;

import com.summit.core.conversation.api.ConversationTranscriptSink;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.execution.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/** Persists only rounds accepted by ConversationManager; compaction never calls this sink. */
@Component
@RequiredArgsConstructor
public class DatabaseConversationTranscriptSink implements ConversationTranscriptSink {
    private final ConversationTranscriptService transcriptService;
    private final ExecutionIdentity executionIdentity;

    @Override
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        transcriptService.appendRound(executionIdentity.sessionId(executionId), aiMessage, toolMessages);
    }
}

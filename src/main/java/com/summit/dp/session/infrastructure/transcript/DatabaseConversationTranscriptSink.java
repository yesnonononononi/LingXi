package com.summit.dp.session.infrastructure.transcript;

import com.summit.core.conversation.api.ConversationTranscriptSink;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/** Persists only rounds accepted by ConversationManager; compaction never calls this sink. */
@Component
@RequiredArgsConstructor
public class DatabaseConversationTranscriptSink implements ConversationTranscriptSink {
    private final ConversationTranscriptService transcriptService;
    private final ExecutionIdentity executionIdentity;

    /**
     * 落一轮模型输出。
     *
     * <p>轮次 ID 来自请求事件元数据。旧执行缺少元数据时归属未知，不反查、不猜测。</p>
     */
    @Override
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        appendRound(executionId, aiMessage, toolMessages, Map.of());
    }

    @Override
    public void appendRound(String executionId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, Map<String, Object> eventMetaData) {
        long sessionId = executionIdentity.sessionId(executionId);
        transcriptService.appendRound(sessionId, ExecutionEventMetadata.turnId(eventMetaData),
                aiMessage, toolMessages);
    }
}

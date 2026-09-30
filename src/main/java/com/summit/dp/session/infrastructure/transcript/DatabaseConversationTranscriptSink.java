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

    /**
     * 落一轮模型输出。会话与执行归属都从框架给的 {@code executionId} 解析：
     * 同一执行的多轮输出因此挂在同一个 {@code execution_id} 上，前端按它分组，
     * 用量与模型信息也按同一键对账。
     */
    @Override
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        transcriptService.appendRound(executionIdentity.sessionId(executionId),
                ExecutionIdentity.numericOrNull(executionId), aiMessage, toolMessages);
    }
}

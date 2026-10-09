package com.summit.dp.session.infrastructure.transcript;

import com.summit.core.conversation.api.ConversationTranscriptSink;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/** 框架响应身份必须进入历史幂等键，不能通过无身份入口追加模型消息。 */
@Component
@RequiredArgsConstructor
public class DatabaseConversationTranscriptSink implements ConversationTranscriptSink {
    private final ConversationTranscriptService transcriptService;
    private final ExecutionIdentity executionIdentity;

    @Override
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        throw new ClientException("记录模型响应必须使用携带响应身份的入口");
    }

    /** 身份和归属来自框架，缺失身份由业务入口拒绝。 */
    @Override
    @Transactional
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages,
                            String responseId, Map<String, Object> eventMetaData) {
        // 会话归属与投递根身份必须分开，子执行不能投进自身桶。
        long sessionId = resolveSessionId(executionId, eventMetaData);
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(eventMetaData);
        transcriptService.appendRound(sessionId, rootSessionId,
                ExecutionEventMetadata.turnId(eventMetaData),
                aiMessage, toolMessages, responseId);
    }

    /** 元数据缺失时仍查询权威执行归属，不能猜一个会话身份。 */
    private long resolveSessionId(String executionId, Map<String, Object> eventMetaData) {
        Long sessionId = ExecutionEventMetadata.sessionId(eventMetaData);
        if (sessionId != null) {
            return sessionId;
        }
        return executionIdentity.sessionId(executionId);
    }
}

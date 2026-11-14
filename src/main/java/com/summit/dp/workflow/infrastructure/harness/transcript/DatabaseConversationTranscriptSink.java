package com.summit.dp.workflow.infrastructure.harness.transcript;

import com.summit.core.conversation.api.ConversationTranscriptSink;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/** 模型响应身份是历史的幂等键：sink 只开放携带身份的入口，缺失由框架契约挡在编译期。 */
@Component
@RequiredArgsConstructor
public class DatabaseConversationTranscriptSink implements ConversationTranscriptSink {
    private final ConversationTranscriptService transcriptService;
    private final ExecutionLocator executionLocator;
    private final GeneratedImagePersistence imagePersistence;

    @Override
    @Transactional
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages,
                            String responseId, Map<String, Object> eventMetaData) {
        // 会话归属与投递根身份必须分开，子执行不能投进自身桶。
        long sessionId = resolveSessionId(executionId, eventMetaData);
        imagePersistence.persist(sessionId, aiMessage);
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
        return executionLocator.sessionId(executionId);
    }
}

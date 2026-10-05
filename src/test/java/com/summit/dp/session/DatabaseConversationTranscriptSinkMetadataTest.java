package com.summit.dp.session;

import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.infrastructure.transcript.DatabaseConversationTranscriptSink;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DatabaseConversationTranscriptSinkMetadataTest {
    private final ConversationTranscriptService transcript = mock(ConversationTranscriptService.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final DatabaseConversationTranscriptSink sink = new DatabaseConversationTranscriptSink(transcript, identity);

    /**
     * 元数据带 sessionId 时以它为准：正常路径不查执行表，故对 identity 不设 stub。
     *
     * <p>根身份**原样透传**：元数据没有 rootSessionId 就是 null，不在这里回落自身会话 ——
     * 回落等于把「子会话提交投错桶」从观察者挪到上游，照样投错且更隐蔽。缺失由通知侧告警跳过。</p>
     */
    @Test
    void outputUsesMetadataSessionIdentityWithoutLookup() {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(),
                Map.of("turnId", "9007199254740995", "sessionId", "777", "streamKey", "70001"));

        verify(transcript).appendRound(777L, null, 9007199254740995L, ai, List.of(), "70001");
        org.mockito.Mockito.verifyNoInteractions(identity);
    }

    /** 元数据缺 sessionId（异常构造的执行）才回退执行表，避免落错会话。 */
    @Test
    void fallsBackToExecutionLookupWhenMetadataLacksSessionId() {
        when(identity.sessionId("execution")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), Map.of("streamKey", "70001"));

        verify(transcript).appendRound(500L, null, null, ai, List.of(), "70001");
    }

    /** 完全无元数据（框架旧签名入口）同样走回退，轮次与响应身份保持未知。 */
    @Test
    void legacyOutputKeepsTurnAndStreamKeyUnknownWithoutLookup() {
        when(identity.sessionId("legacy")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("legacy", ai, List.of());

        verify(transcript).appendRound(500L, null, null, ai, List.of(), null);
    }

    @Test
    void blankStreamKeyIsTreatedAsUnknown() {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), Map.of("sessionId", "777", "streamKey", "  "));

        verify(transcript).appendRound(777L, null, null, ai, List.of(), null);
    }
}

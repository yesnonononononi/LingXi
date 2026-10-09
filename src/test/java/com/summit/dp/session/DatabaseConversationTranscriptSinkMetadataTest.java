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
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 落库入口的归属与身份解析。
 *
 * <p><b>响应身份必须从框架参数进来、不从元数据里找</b>：框架只调 5 参重载，
 * 身份是它的 {@code ChatResponseEntity.responseId}。这里守住的是「5 参入口真的把身份
 * 传给了下游」—— 只覆写 4 参会编译通过、测试全绿，但身份在 default 方法里被静默丢弃。</p>
 */
class DatabaseConversationTranscriptSinkMetadataTest {
    private static final String RESPONSE_ID = "3c9a7e21-5d64-4b18-9f2a-7e6c1b0d4a53";

    private final ConversationTranscriptService transcript = mock(ConversationTranscriptService.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final DatabaseConversationTranscriptSink sink = new DatabaseConversationTranscriptSink(transcript, identity);

    /**
     * 5 参入口（框架唯一实际调用点）把身份原样交给下游。
     *
     * <p>元数据里**没有**身份相关的键 —— 身份只可能来自本参数。</p>
     */
    @Test
    void frameworkEntryPassesResponseIdDownstream() {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), RESPONSE_ID,
                Map.of("turnId", "9007199254740995", "sessionId", "777"));

        verify(transcript).appendRound(777L, null, 9007199254740995L, ai, List.of(), RESPONSE_ID);
        verifyNoInteractions(identity);
    }

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
                Map.of("turnId", "9007199254740995", "sessionId", "777"));

        verify(transcript).appendRound(777L, null, 9007199254740995L, ai, List.of(), null);
        verifyNoInteractions(identity);
    }

    /** 元数据缺 sessionId（异常构造的执行）才回退执行表，避免落错会话。 */
    @Test
    void fallsBackToExecutionLookupWhenMetadataLacksSessionId() {
        when(identity.sessionId("execution")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), RESPONSE_ID, Map.of());

        verify(transcript).appendRound(500L, null, null, ai, List.of(), RESPONSE_ID);
    }

    /** 完全无元数据（框架旧签名入口）同样走回退，轮次与响应身份保持未知。 */
    @Test
    void legacyOutputKeepsTurnAndResponseIdUnknownWithoutLookup() {
        when(identity.sessionId("legacy")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("legacy", ai, List.of());

        verify(transcript).appendRound(500L, null, null, ai, List.of(), null);
    }

    /** 4 参入口（无身份）不得伪造一个身份出来：缺就是缺。 */
    @Test
    void fourArgEntryKeepsResponseIdUnknown() {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), Map.of("sessionId", "777"));

        verify(transcript).appendRound(777L, null, null, ai, List.of(), null);
    }
}

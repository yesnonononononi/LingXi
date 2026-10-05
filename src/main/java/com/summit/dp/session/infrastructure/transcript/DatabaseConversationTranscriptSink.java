package com.summit.dp.session.infrastructure.transcript;

import com.summit.core.conversation.api.ConversationTranscriptSink;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * 只有接纳提交后才消费响应身份，上下文压缩不能改写历史。
 *
 * <p><b>响应身份直取元数据</b>：{@code streamKey} 由
 * {@code StreamResponseIdentityInterceptor} 在每轮模型调用前写入事件元数据，
 * 本类直接读它、不再经过共享投影预占 —— 于是落库身份与实时身份同源，
 * 重复落库由 {@code (session_id, stream_key)} 幂等拦住，不再需要预留/回滚语义。</p>
 *
 * <p><b>会话归属同样直取元数据</b>：{@code sessionId} 是执行请求的一部分，
 * 由 {@code RequestPreparer} 与 {@code SessionAttributeRestorer} 写入（两者都经
 * {@link ExecutionEventMetadata#of} 构造，恒带该键）。因此正常路径零查库；
 * 仅当元数据缺失（异常构造的执行、历史脏数据）才回退一次执行表查询，避免静默落到错误会话。</p>
 */
@Component
@RequiredArgsConstructor
public class DatabaseConversationTranscriptSink implements ConversationTranscriptSink {
    private final ConversationTranscriptService transcriptService;
    private final ExecutionIdentity executionIdentity;

    /**
     * 落一轮模型输出。
     *
     * <p>轮次与响应身份来自请求事件元数据。旧执行缺少元数据时归属未知，不反查、不猜测。</p>
     */
    @Override
    @Transactional
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        appendRound(executionId, aiMessage, toolMessages, Map.of());
    }

    @Override
    @Transactional
    public void appendRound(String executionId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, Map<String, Object> eventMetaData) {
        // 投递用根、归属用自身会话：子执行的 AI/工具行必须投到根连接，否则前端收不到。
        long sessionId = resolveSessionId(executionId, eventMetaData);
        // 根身份**原样透传**：缺失就是缺失。在这里回落自身会话，等于把观察者的错误回落挪到上游 ——
        // 子执行缺根元数据时照样投错桶，而且错得更隐蔽。缺失由通知侧告警并跳过；
        // 旧检查点的身份补全属于恢复入口的职责。
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(eventMetaData);
        transcriptService.appendRound(sessionId, rootSessionId,
                ExecutionEventMetadata.turnId(eventMetaData),
                aiMessage, toolMessages, ExecutionEventMetadata.streamKey(eventMetaData));
    }

    /**
     * 取本次落库的会话归属：元数据优先，缺失才回退执行表。
     *
     * <p>回退是防御而非主路径 —— 正常执行恒带 {@code sessionId}；留在它是为了让「元数据不全」
     * 时仍能落对会话，而不是抛错丢掉这一轮模型输出。</p>
     */
    private long resolveSessionId(String executionId, Map<String, Object> eventMetaData) {
        Long sessionId = ExecutionEventMetadata.sessionId(eventMetaData);
        if (sessionId != null) {
            return sessionId;
        }
        return executionIdentity.sessionId(executionId);
    }
}

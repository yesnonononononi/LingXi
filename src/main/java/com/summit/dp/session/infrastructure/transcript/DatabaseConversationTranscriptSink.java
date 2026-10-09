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
 * <p><b>响应身份取自框架</b>：{@code responseId} 由框架在每次模型调用前生成
 * （由框架的 ResponseIdGenerator 分配），
 * 随 {@link com.summit.core.conversation.api.ChatResponseEntity} 一路传到本入口 ——
 * 历史落库、实时事件与工具来源因此共用同一个身份，不再各造一份。
 * 重复落库由 {@code (session_id, response_id)} 幂等拦住。</p>
 *
 * <p><b>为什么必须覆写 5 参版本</b>：框架只调 5 参重载。若只覆写 4 参，
 * 框架的 default 实现会把 {@code responseId} 丢掉再转调 4 参 —— 身份静默消失、
 * 幂等拦截失效，且不报错。这是本类唯一必须覆写的入口。</p>
 *
 * <p><b>会话归属直取元数据</b>：{@code sessionId} 是执行请求的一部分，
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
        appendRound(executionId, aiMessage, toolMessages, null, eventMetaData);
    }

    /**
     * 框架的**唯一**实际调用入口：接住本轮模型调用身份并落库。
     *
     * <p>{@code responseId} 缺省即缺省 —— 不在这里造一个替代身份（那会让幂等键与实时事件
     * 用的身份分叉，反而比没有更糟）。缺失时 {@code ConversationTranscriptService} 退化为
     * 无条件追加，与「身份未知」的旧数据口径一致。</p>
     */
    @Override
    @Transactional
    public void appendRound(String executionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages,
                            String responseId, Map<String, Object> eventMetaData) {
        // 投递用根、归属用自身会话：子执行的 AI/工具行必须投到根连接，否则前端收不到。
        long sessionId = resolveSessionId(executionId, eventMetaData);
        // 根身份**原样透传**：缺失就是缺失。在这里回落自身会话，等于把观察者的错误回落挪到上游 ——
        // 子执行缺根元数据时照样投错桶，而且错得更隐蔽。缺失由通知侧告警并跳过；
        // 旧检查点的身份补全属于恢复入口的职责。
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(eventMetaData);
        transcriptService.appendRound(sessionId, rootSessionId,
                ExecutionEventMetadata.turnId(eventMetaData),
                aiMessage, toolMessages, responseId);
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

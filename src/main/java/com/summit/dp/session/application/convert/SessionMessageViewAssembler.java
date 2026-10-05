package com.summit.dp.session.application.convert;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.shared.vo.SessionMessageVO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 会话消息视图装配器（纯转换）：{@link SessionMessage} → {@link SessionMessageVO}，只做纯内存解析。
 *
 * <p><b>不持有仓储、不发起查询（评审 P1-③）：</b>工具调用的聚合装载由应用层
 * {@code SessionMessageQueryService} 在一次批量查询内完成；本类是纯函数，可独立单测、可复用。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionMessageViewAssembler {

    private final ObjectMapper objectMapper;
    private final ToolCallConverter toolCallConverter;

    /**
     * 单条转换：USER/SYSTEM/ERROR → 正文；AI → 正文 + 思维链 + 请求视图；TOOL → {@code toolCallId}。
     *
     * <p>TOOL 行的聚合工具调用由应用层批量装载回填；本方法不触达任何持久化。</p>
     *
     * <p>{@code turnId} 直接取自存储态消息（旧数据为 {@code null}）：
     * 归属是消息行自己的列，不需要在这里或应用层再做一次映射。
     * 缺省即降级，**不在这里按位置补一个猜出来的归属**。</p>
     */
    public SessionMessageVO toVO(SessionMessage stored) {
        SessionMessageVO.SessionMessageVOBuilder builder = SessionMessageVO.builder()
                .id(stored.getId())
                .sessionId(stored.getSessionId())
                .streamKey(stored.getStreamKey() == null ? "history:" + stored.getId() : stored.getStreamKey())
                .turnId(stored.getTurnId())
                .type(stored.getType().name())
                .createTime(stored.getCreateTime());

        switch (stored.getType()) {
            case USER -> {
                UserMessageEntity message = parse(stored.getText(), UserMessageEntity.class);
                builder.text(message == null ? stored.getText() : message.text());
            }
            case SYSTEM -> {
                SystemMessageEntity message = parse(stored.getText(), SystemMessageEntity.class);
                builder.text(message == null ? stored.getText() : message.text());
            }
            case AI -> {
                AiMessageEntity message = parse(stored.getText(), AiMessageEntity.class);
                if (message == null) {
                    builder.text(stored.getText());
                } else {
                    builder.text(message.text())
                            .thinking(message.getThinking())
                            .toolCalls(toolCallConverter.toModelToolCalls(message.getToolCalls()));
                }
            }
            case TOOL -> {
                // content 即 call_id（设计 §7.3）；结果与状态由应用层批量装载回填。
                builder.toolCallId(stored.getText());
            }
        }
        return builder.build();
    }

    /** 解析失败降级：返回 {@code null} 并告警，消息本身不丢。 */
    private <T> T parse(String content, Class<T> type) {
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(content, type);
        } catch (Exception e) {
            log.warn("会话消息载荷解析失败，按不可用处理: type={}, error={}", type.getSimpleName(), e.getMessage());
            return null;
        }
    }
}

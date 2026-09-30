package com.summit.dp.session.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import cn.hutool.core.util.IdUtil;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Append-only, user-visible transcript. It is deliberately independent from the mutable model context.
 *
 * <p><b>每条消息都带 {@code executionId}（2026-09-30 改造）：</b>它是「回答分组」与
 * 「本轮元信息归属」的唯一稳定键 —— 前端按它把 USER / AI / TOOL / ERROR 归到同一轮，
 * 并把 execution 摘要挂到组上。此前只能按「页内 USER 消息」划轮，分页切在
 * AI/TOOL/ERROR 中间时会造出孤行容器。{@code executionId} 为 {@code null} 只出现在
 * 本次改造之前落库的旧数据上，表示归属未知。</p>
 *
 * <p><b>TOOL 行只存 {@code call_id}（设计 §7.3）：</b>旧实现把整个 {@code ToolMessageEntity}
 * 序列化进 {@code content}，与 {@code tool_call} 行形成双写、易漂移。现在 TOOL 行的
 * {@code content} 只写模型下发的 {@code call_id}，结果与状态一律以 {@code tool_call} 行为权威源；
 * 写入时尽力回填 {@code tool_call.session_message_id} 锚点（失败不影响消息落库）。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConversationTranscriptService {
    private final MessageRepository messageRepository;
    private final ToolCallRepository toolCallRepository;
    private final ObjectMapper objectMapper;

    @Transactional
    public void appendToolResult(Long sessionId, Long executionId, ToolMessageEntity result) {
        append(sessionId, executionId, List.of(result));
    }

    @Transactional
    public void appendUser(Long sessionId, Long executionId, UserMessageEntity message) {
        append(sessionId, executionId, List.of(message));
    }

    @Transactional
    public void appendRound(Long sessionId, Long executionId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages) {
        List<Message> round = new ArrayList<>();
        round.add(aiMessage);
        if (toolMessages != null) round.addAll(toolMessages);
        append(sessionId, executionId, round);
    }

    /**
     * 追加一条执行失败标注行（{@link SessionMessageType#ERROR}）。
     *
     * <p><b>content 存纯文本，不是框架消息的 JSON 序列化：</b>ERROR 行不参与模型上下文，
     * 只承载给人看的失败文案，前端按正文直接消费，因此无需再包一层 JSON 再去解析
     * （USER/AI 行包 JSON 是因为要还原框架消息的字段，这里没有可还原的字段）。</p>
     *
     * <p>文案为空即不落行，由调用方（事件适配器）负责兜底文案。</p>
     */
    @Transactional
    public void appendError(Long sessionId, Long executionId, String errorMessage) {
        if (errorMessage == null || errorMessage.isBlank()) {
            return;
        }
        SessionMessage record = SessionMessage.builder()
                .id(IdUtil.getSnowflakeNextId())
                .sessionId(sessionId)
                .executionId(executionId)
                .type(SessionMessageType.ERROR)
                .text(errorMessage)
                .build();
        messageRepository.appendAll(sessionId, List.of(record));
    }

    private void append(Long sessionId, Long executionId, List<? extends Message> messages) {
        List<SessionMessage> records = new ArrayList<>();
        // callId → 新生成的 TOOL 行主键，用于回填 tool_call.session_message_id。
        Map<String, Long> toolAnchors = new LinkedHashMap<>();
        for (Message message : messages) {
            SessionMessageType type = typeOf(message);
            Long messageId = IdUtil.getSnowflakeNextId();
            if (type == SessionMessageType.TOOL && message instanceof ToolMessageEntity tool) {
                String callId = tool.getId() == null ? null : String.valueOf(tool.getId());
                if (callId != null) {
                    toolAnchors.put(callId, messageId);
                }
                // content 只写 call_id，不再序列化 {id,name,args,output}。
                records.add(SessionMessage.builder()
                        .id(messageId)
                        .sessionId(sessionId)
                        .executionId(executionId)
                        .type(type)
                        .text(callId)
                        .build());
                continue;
            }
            try {
                records.add(SessionMessage.builder()
                        .id(messageId)
                        .sessionId(sessionId)
                        .executionId(executionId)
                        .type(type)
                        // Serialize synchronously: framework messages remain mutable and may later be compacted.
                        .text(objectMapper.writeValueAsString(message))
                        .build());
            } catch (JsonProcessingException e) {
                log.error("Failed to serialize message", e);
            }
        }
        messageRepository.appendAll(sessionId, records);
        backfillAnchors(toolAnchors);
    }

    /** 尽力回填 TOOL 行锚点；任何失败只告警，不影响已写入的消息。 */
    private void backfillAnchors(Map<String, Long> toolAnchors) {
        toolAnchors.forEach((callId, messageId) -> {
            try {
                toolCallRepository.bindSessionMessage(callId, messageId);
            } catch (RuntimeException e) {
                log.warn("回填 tool_call.session_message_id 失败: callId={}, error={}", callId, e.toString());
            }
        });
    }

    private static SessionMessageType typeOf(Message message) {
        if (message instanceof UserMessageEntity) return SessionMessageType.USER;
        if (message instanceof AiMessageEntity) return SessionMessageType.AI;
        if (message instanceof ToolMessageEntity) return SessionMessageType.TOOL;
        return SessionMessageType.SYSTEM;
    }
}

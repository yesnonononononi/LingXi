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
    public void appendToolResult(Long sessionId, ToolMessageEntity result) {
        append(sessionId, List.of(result));
    }

    @Transactional
    public void appendUser(Long sessionId, UserMessageEntity message) {
        append(sessionId, List.of(message));
    }

    @Transactional
    public void appendRound(Long sessionId, AiMessageEntity aiMessage, List<ToolMessageEntity> toolMessages) {
        List<Message> round = new ArrayList<>();
        round.add(aiMessage);
        if (toolMessages != null) round.addAll(toolMessages);
        append(sessionId, round);
    }

    private void append(Long sessionId, List<? extends Message> messages) {
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
                        .type(type)
                        .text(callId)
                        .build());
                continue;
            }
            try {
                records.add(SessionMessage.builder()
                        .id(messageId)
                        .sessionId(sessionId)
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

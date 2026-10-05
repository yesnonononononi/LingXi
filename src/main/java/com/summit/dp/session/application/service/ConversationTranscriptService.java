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
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 历史独立于可变上下文；TOOL 只存调用身份，内容以工具实体为准。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConversationTranscriptService {
    private final MessageRepository messageRepository;
    private final ToolCallRepository toolCallRepository;
    private final TranscriptRecordAssembler recordAssembler;

    @Transactional
    public void appendToolResult(Long sessionId, Long rootSessionId, Long turnId, ToolMessageEntity result) {
        append(sessionId, rootSessionId, turnId, List.of(result));
    }

    @Transactional
    public void appendUser(Long sessionId, Long rootSessionId, Long turnId, UserMessageEntity message) {
        append(sessionId, rootSessionId, turnId, List.of(message));
    }

    @Transactional
    public void appendRound(Long sessionId, Long rootSessionId, Long turnId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages) {
        appendRound(sessionId, rootSessionId, turnId, aiMessage, toolMessages, null);
    }

    /**
     * 追加一轮（AI + 工具结果）。
     *
     * @param rootSessionId v3 投递目标；子会话必须传根，否则提交帧投进子会话桶而无人接收
     */
    @Transactional
    public void appendRound(Long sessionId, Long rootSessionId, Long turnId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, String streamKey) {
        if (streamKey != null && messageRepository.findByStreamKey(sessionId, streamKey).isPresent()) return;
        List<Message> round = new ArrayList<>();
        round.add(aiMessage);
        if (toolMessages != null) round.addAll(toolMessages);
        append(sessionId, rootSessionId, turnId, round, streamKey);
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId, List<? extends Message> messages) {
        append(sessionId, rootSessionId, turnId, messages, null);
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId,
                        List<? extends Message> messages, String streamKey) {
        List<SessionMessage> records = recordAssembler.build(sessionId, turnId, messages, streamKey);
        messageRepository.appendAll(sessionId, rootSessionId, records);
        for (SessionMessage record : records) {
            if (record.getType() != SessionMessageType.TOOL || record.getText() == null) continue;
            try {
                toolCallRepository.bindSessionMessage(record.getText(), record.getId());
            } catch (RuntimeException e) {
                log.warn("回填工具消息锚点失败: callId={}, error={}", record.getText(), e.toString());
            }
        }
    }
}

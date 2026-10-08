package com.summit.dp.session.application.service;

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
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** 历史独立于可变上下文；TOOL 只存调用身份，内容以工具实体为准。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConversationTranscriptService {
    private final MessageRepository messageRepository;
    private final ToolCallRepository toolCallRepository;
    private final TranscriptRecordAssembler recordAssembler;
    private final TranscriptReplayMatcher replayMatcher;

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
     * @param responseId    框架下发的本轮模型调用身份；非空时作为幂等键，拦重复落库
     */
    @Transactional
    public void appendRound(Long sessionId, Long rootSessionId, Long turnId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, UUID responseId) {
        // 顺序不可动：先锁定会话行使并发落库串行化，再做「查 → 比对 → 插」。
        // 若先查再插（旧实现），两个并发方会同时通过检查，再一起去撞唯一索引 —— 幂等形同虚设。
        if (responseId != null) {
            messageRepository.lockSessionForAppend(sessionId);
            Optional<SessionMessage> existing = messageRepository.findByResponseId(sessionId, responseId);
            if (existing.isPresent()) {
                // 已落库 ≠ 一定是重放：内容不一致说明有人的状态算错了，必须让人看见，不能静默 return。
                if (!replayMatcher.isSameRound(existing.get(), turnId, aiMessage)) {
                    throw replayMatcher.driftError(sessionId, responseId);
                }
                return;
            }
        }
        List<Message> round = new ArrayList<>();
        round.add(aiMessage);
        if (toolMessages != null) round.addAll(toolMessages);
        append(sessionId, rootSessionId, turnId, round, responseId);
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId, List<? extends Message> messages) {
        append(sessionId, rootSessionId, turnId, messages, null);
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId,
                        List<? extends Message> messages, UUID responseId) {
        List<SessionMessage> records = recordAssembler.build(sessionId, turnId, messages, responseId);
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

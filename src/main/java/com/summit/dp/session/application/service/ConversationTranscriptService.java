package com.summit.dp.session.application.service;

import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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

    /** 会话行锁保护幂等判断，唯一索引仍裁决绕过该入口的重复写入。 */
    @Transactional
    public void appendRound(Long sessionId, Long rootSessionId, Long turnId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, String responseId) {
        throwIf(responseId == null || !responseId.matches("[0-9]+"), "模型响应身份必须是框架生成的数字标识");
        messageRepository.lockSessionForAppend(sessionId);
        Optional<SessionMessage> existing = messageRepository.findByResponseId(sessionId, responseId);
        if (existing.isPresent()) {
            requireSameRound(existing.get(), sessionId, responseId, turnId, aiMessage);
            return;
        }
        List<Message> round = new ArrayList<>();
        round.add(aiMessage);
        if (toolMessages != null) round.addAll(toolMessages);
        try {
            append(sessionId, rootSessionId, turnId, round, responseId);
        } catch (DuplicateKeyException duplicated) {
            // 唯一键冲突等价于「这一轮已经落过」：回查后按漂移规则收口，
            // 不能把驱动的约束异常泄漏给调用方（重放与并发重复提交都必须幂等）。
            SessionMessage landed = messageRepository.findByResponseId(sessionId, responseId)
                    .orElseThrow(() -> duplicated);
            requireSameRound(landed, sessionId, responseId, turnId, aiMessage);
            return;
        }
    }

    /** 同一 responseId 的重复提交只允许「完全同一轮」，否则是内容漂移，必须暴露。 */
    private void requireSameRound(SessionMessage landed, Long sessionId, String responseId,
                                  Long turnId, AiMessageEntity aiMessage) {
        if (!replayMatcher.isSameRound(landed, turnId, aiMessage)) {
            throw replayMatcher.driftError(sessionId, responseId);
        }
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId, List<? extends Message> messages) {
        append(sessionId, rootSessionId, turnId, messages, null);
    }

    private void append(Long sessionId, Long rootSessionId, Long turnId,
                        List<? extends Message> messages, String responseId) {
        List<SessionMessage> records = recordAssembler.build(sessionId, turnId, messages, responseId);
        messageRepository.appendAll(sessionId, rootSessionId, records);

        // 锚点回填：一轮的所有 TOOL 行合并成一条批量 UPDATE。仍是尽力而为 ——
        // 锚点只服务于「消息 → 工具卡片」的回指，回填失败不该让已经落定的转录整体回滚。
        Map<String, Long> bindings = new LinkedHashMap<>();
        for (SessionMessage record : records) {
            if (record.getType() != SessionMessageType.TOOL || record.getText() == null) continue;
            bindings.put(record.getText(), record.getId());
        }
        if (bindings.isEmpty()) {
            return;
        }
        try {
            toolCallRepository.bindSessionMessagesBatch(bindings);
        } catch (RuntimeException e) {
            log.warn("回填工具消息锚点失败: 条数={}, error={}", bindings.size(), e.toString());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

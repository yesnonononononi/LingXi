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
import java.util.List;

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

    /**
     * 追加一轮（AI + 工具结果）。
     *
     * <p><b>为什么先写后查</b>：SQLite 只有一个写者，事务里「先读后升写」在竞争时不会排队
     * （升写失败立刻返回 SQLITE_BUSY，busy_timeout 对升写不生效）。这里让事务的第一条语句就是
     * 插入：抢不到锁由 busy_timeout 正常等待；并发重复提交由 {@code uk_session_response_id}
     * 唯一索引裁决，冲突后回查再决定「幂等复用」还是「内容漂移」。行锁删掉后，唯一的并发裁决
     * 就是这个唯一索引。</p>
     *
     * @param rootSessionId v3 投递目标；子会话必须传根，否则提交帧投进子会话桶而无人接收
     * @param responseId    框架下发的本轮模型调用身份；作为幂等键，拦重复落库
     */
    @Transactional
    public void appendRound(Long sessionId, Long rootSessionId, Long turnId, AiMessageEntity aiMessage,
                            List<ToolMessageEntity> toolMessages, String responseId) {
        throwIf(responseId == null || !responseId.matches("[0-9]+"), "模型响应身份必须是框架生成的数字标识");
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
        // 落库成功后再确认会话存在：这是真实调用错误的兜底校验，放在写入之后，
        // 以免在事务开头引入一次「读」把写变成「读后升写」。
        messageRepository.lockSessionForAppend(sessionId);
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
        for (SessionMessage record : records) {
            if (record.getType() != SessionMessageType.TOOL || record.getText() == null) continue;
            try {
                toolCallRepository.bindSessionMessage(record.getText(), record.getId());
            } catch (RuntimeException e) {
                log.warn("回填工具消息锚点失败: callId={}, error={}", record.getText(), e.toString());
            }
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

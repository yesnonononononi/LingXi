package com.summit.dp.session.application.service;

import com.summit.core.conversation.message.Message;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.shared.event.CommittedStateChange;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.beans.factory.annotation.Autowired;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 会话回滚：把会话砍回某个历史提问之前，只服务「重发」。
 *
 * <p>目标轮次及其之后的 {@code session_message} / {@code tool_call} / {@code chat_turn}
 * 在同一个事务里全部作废；模型上下文由调用方传入 —— 它可能已被压缩，与 transcript 不是同一份数据。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConversationRollbackService {

    private final MessageRepository messageRepository;
    private final ToolCallRepository toolCallRepository;
    private final ChatTurnService chatTurnService;
    private final ModelContextService modelContextService;
    @Autowired(required = false)
    private SessionRepository sessions;
    @Autowired(required = false)
    private CommittedStatePublisher changes;

    /**
     * 回滚到目标轮次之前。
     *
     * <p>调用方必须先拿到该会话的运行资格，并且必须在本方法之后才落库新的用户提问。</p>
     *
     * @param sessionId 目标轮次所属的会话
     * @param turnId    目标轮次；它及其之后的消息、卡片、轮次全部作废
     * @param baseline  回滚后应当生效的模型上下文（不含被作废轮次的用户提问）
     * @return 被作废范围与作废后的历史版本，供 v2 重发回执直接下发
     */
    @Transactional
    public RollbackResult rollbackBefore(long sessionId, long turnId, List<Message> baseline) {
        List<ChatTurn> removedTurns = chatTurnService.rollbackFrom(sessionId, turnId);

        List<Long> executionIds = removedTurns.stream()
                .map(ChatTurn::getExecutionId)
                .filter(Objects::nonNull)
                .toList();

        int removedCards = toolCallRepository.deleteByExecutionIds(executionIds);

        int removedMessages = messageRepository.deleteFromTurn(sessionId, turnId);

        modelContextService.replace(sessionId, baseline);
        Set<String> invalidatedTurns = removedTurns.stream()
                .map(turn -> String.valueOf(turn.getId())).collect(Collectors.toSet());
        Set<String> invalidatedExecutions = executionIds.stream()
                .map(String::valueOf).collect(Collectors.toSet());
        Long historyRevision = null;
        if (sessions != null) {
            Session owned = sessions.findById(sessionId).orElseThrow(ClientException::new);
            long rootId = owned.isSubSession() ? owned.getRootSessionId() : owned.getId();
            Session root = sessions.findById(rootId).orElseThrow(ClientException::new);
            root.advanceHistoryRevision();
            sessions.updateById(root);
            historyRevision = root.getHistoryRevision();
            if (changes != null) changes.publish(new CommittedStateChange(CommittedStateChange.Kind.HISTORY,
                    rootId, rootId, String.valueOf(rootId), historyRevision, invalidatedTurns,
                    invalidatedExecutions, root.getHistoryRevision()));
        }

        log.info("回滚会话历史: sessionId={}, turnId={}, removedTurns={}, removedMessages={}, removedCards={}",
                sessionId, turnId, removedTurns.size(), removedMessages, removedCards);

        return new RollbackResult(historyRevision, invalidatedTurns, invalidatedExecutions);
    }

    /**
     * 一次回滚的结果。
     *
     * <p><b>为什么要把它回传给调用方</b>：重发是破坏性操作，前端必须知道<b>哪些实体已经不存在了</b>，
     * 否则会留下一批指向已删除轮次的气泡与卡片，点进去全是空。回传范围比重发后让前端
     * 重拉全量历史便宜得多，也让「已受理」这一步就能把作废事实说清楚。</p>
     *
     * @param historyRevision          作废后的历史版本；会话仓储不可用时为 {@code null}
     * @param invalidatedTurnIds       被作废的轮次 id
     * @param invalidatedExecutionIds  被作废轮次对应的执行 id
     */
    public record RollbackResult(Long historyRevision,
                                 Set<String> invalidatedTurnIds,
                                 Set<String> invalidatedExecutionIds) {

        public RollbackResult {
            invalidatedTurnIds = invalidatedTurnIds == null ? Set.of() : Set.copyOf(invalidatedTurnIds);
            invalidatedExecutionIds = invalidatedExecutionIds == null
                    ? Set.of() : Set.copyOf(invalidatedExecutionIds);
        }
    }
}

package com.summit.dp.stream.application.service;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.*;

/** 查询在投影门闩之外完成，覆盖全部等待槽位和最近轮次。 */
@Service
@RequiredArgsConstructor
public class StreamSnapshotAssembler {
    private final SessionRepository sessions;
    private final ToolCallRepository tools;
    private final StreamClientViewAssembler views;
    private final TurnRetainResolver turnRetain;
    private final MessageRetainResolver messageRetain;
    private final TransactionTemplate transactions;
    /** 执行摘要与轮次保留判定共用同一仓储：同一执行不允许出现两份口径。 */
    private final ExecutionRepository executions;
    public static final int RETAINED_COMPLETED_TURNS = 32;

    /**
     * 快照重读次数上限。
     *
     * <p>读跨多个会话多个表，期间可能有提交推进 {@code historyRevision}；此时读到的是
     * 一个「跨时刻」的快照，必须整体重读。给 3 次是够的：重试仍不一致说明有写入在
     * 持续发生，此时抛业务失败让前端重新同步，比继续读到撕裂数据更安全。</p>
     */
    public static final int MAX_LOAD_ATTEMPTS = 3;

    public Base load(long rootId) {
        TransactionTemplate read = new TransactionTemplate(transactions.getTransactionManager());
        read.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        read.setReadOnly(true);
        read.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        for (int attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
            Base base = read.execute(status -> {
                Session root = sessions.findById(rootId).orElseThrow(ClientException::new);
                throwIf(root.isSubSession(), "流式订阅必须使用根会话");
                List<Session> tree = sessions.findSessionTree(rootId);
                List<Long> sessionIds = tree.stream().map(Session::getId).toList();
                Set<Long> unfinishedIds = turnRetain.resolveUnfinishedExecutions(sessionIds);
                List<ChatTurn> allTurns = turnRetain.loadAllTurns(tree);
                Set<Long> retained = turnRetain.resolveRetained(allTurns, unfinishedIds);
                List<ChatTurn> selectedTurns = allTurns.stream().filter(turn -> retained.contains(turn.getId())).toList();
                Set<Long> executionIds = new LinkedHashSet<>();
                selectedTurns.stream().map(ChatTurn::getExecutionId).filter(Objects::nonNull).forEach(executionIds::add);
                List<ToolCall> selectedTools = new ArrayList<>();
                for (Session session : tree) {
                    for (ToolCall tool : tools.listByConversationId(session.getId())) {
                        if (tool.isUnresolved() || executionIds.contains(tool.getExecutionId())) {
                            selectedTools.add(tool);
                            if (tool.getExecutionId() != null) executionIds.add(tool.getExecutionId());
                        }
                    }
                }
                List<SessionMessage> selectedMessages = messageRetain.resolve(tree, retained);
                executionIds.addAll(unfinishedIds);
                Session latest = sessions.findById(rootId).orElseThrow(ClientException::new);
                if (!Objects.equals(root.getHistoryRevision(), latest.getHistoryRevision())) return null;
                return new Base(root.getHistoryRevision(), tree.stream().map(views::session).toList(),
                        selectedTurns.stream().map(views::turn).toList(),
                        executions.findSummariesByIds(executionIds).stream().map(views::execution).toList(),
                        selectedMessages.stream().map(views::message).toList(),
                        selectedTools.stream().map(views::tool).toList());
            });
            if (base != null) return base;
        }
        throwIf(true, "历史正在变更，请重新同步状态");
        return null;
    }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
    public record Base(long revision, List<ObjectNode> sessions, List<ObjectNode> turns,
                       List<ObjectNode> executions, List<ObjectNode> messages, List<ObjectNode> tools) { }
}

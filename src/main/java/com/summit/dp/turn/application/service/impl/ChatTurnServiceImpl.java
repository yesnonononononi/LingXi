package com.summit.dp.turn.application.service.impl;

import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;

/** 业务轮次应用服务实现。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChatTurnServiceImpl implements ChatTurnService {

    private static final String LOG_PREFIX = "【chat-turn】";

    private final ChatTurnRepository chatTurnRepository;

    @Override
    public long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                           String modelName, String modelProvider) {
        return acceptTurn(sessionId, rootSessionId, parentTurnId, executionId, modelName, modelProvider, null, null);
    }

    /**
     * 带命令身份的受理。
     *
     * <p>命令身份在<b>落库那一刻</b>就与轮次同事务写入：受理与幂等键必须是同一个原子事实。
     * 若先落轮次再补 commandId，中间崩溃会留下一条「已受理但查不回」的命令，
     * 前端重试就会新开一轮并写第二条用户消息。</p>
     */
    @Override
    public long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                           String modelName, String modelProvider,
                           String commandId, String commandDigest) {
        long turnId = IdUtil.getSnowflakeNextId();
        ChatTurn turn = ChatTurn.accept(turnId, sessionId, parentTurnId, modelName, modelProvider);
        // 执行 ID 在 prepare 阶段就已生成，这里直接落库：观察钩子只给 executionId，
        // 若不在此刻写入，START 事件到达时就找不回本轮次（会永远停在 ACCEPTED）。
        turn.attachExecution(executionId);
        turn.attachCommand(commandId, commandDigest);
        chatTurnRepository.save(turn, rootSessionId);
        return turnId;
    }

    @Override
    public Optional<ChatTurn> findByCommandId(String commandId) {
        return chatTurnRepository.findByCommandId(commandId);
    }

    @Override
    @Transactional
    public void markRunning(String executionId, Instant startedAt, Long rootSessionId) {
        mutate(executionId, "markRunning", rootSessionId, turn -> turn.markRunning(startedAt));
    }

    @Override
    public Optional<ChatTurn> findByExecutionId(Long executionId) {
        return chatTurnRepository.findByExecutionId(executionId);
    }

    @Override
    public Map<Long, ChatTurn> findByIds(Collection<Long> turnIds) {
        if (turnIds == null || turnIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, ChatTurn> result = new LinkedHashMap<>();
        for (ChatTurn turn : chatTurnRepository.findByIds(turnIds)) {
            if (turn.getId() != null) {
                result.put(turn.getId(), turn);
            }
        }
        return result;
    }

    @Override
    @Transactional
    public void markWaiting(String executionId, Long rootSessionId) {
        mutate(executionId, "markWaiting", rootSessionId, ChatTurn::markWaiting);
    }

    @Override
    @Transactional
    public void markExecutionWaiting(Execution execution) {
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        markWaiting(execution.getId(), rootSessionId);
    }

    @Override
    @Transactional
    public void finishExecution(Execution execution) {
        ExecutionState state = execution == null ? null : execution.getExecutionState();
        if (state == null) return;
        ChatTurnStatus terminalStatus = switch (state) {
            case COMPLETED -> ChatTurnStatus.COMPLETED;
            case FAILED -> ChatTurnStatus.FAILED;
            case CANCELLED -> ChatTurnStatus.CANCELLED;
            default -> null;
        };
        if (terminalStatus == null) return;
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        // 执行终结与用量事件的到达顺序不固定，不能用空值抹掉已知用量。
        markTerminal(execution.getId(), terminalStatus, null, null, null, execution.getCompletedAt(), rootSessionId);
    }

    @Override
    @Transactional
    public void markTerminal(String executionId, ChatTurnStatus terminalStatus,
                             Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt,
                             Long rootSessionId) {
        if (terminalStatus == null || !terminalStatus.isTerminal()) {
            throw new IllegalArgumentException("markTerminal 只接受终态，收到: " + terminalStatus);
        }
        mutate(executionId, "markTerminal/" + terminalStatus, rootSessionId,
                turn -> applyTerminal(turn, terminalStatus, inputTokens, outputTokens, totalTokens, completedAt));
    }

    /**
     * 分派到对应的领域终结方法。
     *
     * <p>刻意抽成方法而不是在 lambda 里写 {@code switch} **表达式** ——
     * 三个领域方法都返回 void，而 switch 表达式的每个分支都必须产出值，
     * 那样写根本编译不过（本方法的第一版就踩了这个坑）。</p>
     */
    private static void applyTerminal(ChatTurn turn, ChatTurnStatus terminalStatus,
                                      Long inputTokens, Long outputTokens, Long totalTokens,
                                      Instant completedAt) {
        switch (terminalStatus) {
            case COMPLETED -> turn.markCompleted(inputTokens, outputTokens, totalTokens, completedAt);
            case FAILED -> turn.markFailed(inputTokens, outputTokens, totalTokens, completedAt);
            case CANCELLED -> turn.markCancelled(inputTokens, outputTokens, totalTokens, completedAt);
            default -> throw new IllegalArgumentException("非终态: " + terminalStatus);
        }
    }

    @Override
    @Transactional
    public void refreshUsage(String executionId, Long inputTokens, Long outputTokens, Long totalTokens,
                             Long rootSessionId) {
        if (inputTokens == null && outputTokens == null && totalTokens == null) {
            return;
        }
        mutate(executionId, "refreshUsage", rootSessionId,
                turn -> turn.refreshUsage(inputTokens, outputTokens, totalTokens));
    }

    @Override
    @Transactional
    public void recordFailureReason(String executionId, String reason, Long rootSessionId) {
        if (reason == null || reason.isBlank()) {
            return;
        }
        mutate(executionId, "recordFailureReason", rootSessionId, turn -> turn.recordFailureReason(reason));
    }

    @Override
    public int reapOrphans() {
        int reaped = chatTurnRepository.markOrphansFailed(Instant.now());
        if (reaped > 0) {
            log.warn("{} 收口了 {} 条未终结的轮次（进程崩溃残留），已标为 FAILED", LOG_PREFIX, reaped);
        }
        return reaped;
    }

    @Override
    public Map<Long, ChatTurn> findByExecutionIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, ChatTurn> result = new LinkedHashMap<>();
        for (ChatTurn turn : chatTurnRepository.findByExecutionIds(executionIds)) {
            if (turn.getExecutionId() != null) {
                result.put(turn.getExecutionId(), turn);
            }
        }
        return result;
    }

    @Override
    public List<ChatTurn> findActiveBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return List.of();
        }
        return chatTurnRepository.findActiveBySessionIds(sessionIds);
    }

    @Override
    @Transactional
    public List<ChatTurn> rollbackFrom(long sessionId, long fromTurnId) {
        List<ChatTurn> removed = chatTurnRepository.findFromId(sessionId, fromTurnId);
        if (removed.isEmpty()) {
            return removed;
        }
        chatTurnRepository.deleteFromId(sessionId, fromTurnId);
        return removed;
    }

    /**
     * 按执行 ID 找到轮次并施加一次变更；找不到就跳过。
     *
     * <p>归属解析走 {@code execution_id} 的唯一键，**不按「会话最新执行」反查** ——
     * 并发下那样必然认错轮次。执行 ID 非数字（框架兜底 UUID 路径）同样跳过。</p>
     *
     * <p>领域方法抛出的非法转移异常不在这里吞掉：它代表真实的状态机违约，
     * 应当暴露出来（观察钩子自身有 try/catch 兜底，不会打断主链路）。</p>
     */
    private void mutate(String executionId, String action, Long rootSessionId, Consumer<ChatTurn> mutation) {
        Long id = ExecutionIdentity.numericOrNull(executionId);
        if (id == null) {
            return;
        }
        ChatTurn turn = chatTurnRepository.findByExecutionId(id).orElse(null);
        if (turn == null) {
            // 本次改造之前的执行没有对应轮次行；这是预期形态，不是异常。
            log.debug("{} {} 跳过：执行无对应轮次 executionId={}", LOG_PREFIX, action, executionId);
            return;
        }
        mutation.accept(turn);
        chatTurnRepository.updateById(turn, rootSessionId);
    }
}

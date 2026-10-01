package com.summit.dp.turn.application.service.impl;

import cn.hutool.core.util.IdUtil;
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
    public long acceptTurn(long sessionId, Long parentTurnId, Long executionId,
                           String modelName, String modelProvider) {
        long turnId = IdUtil.getSnowflakeNextId();
        ChatTurn turn = ChatTurn.accept(turnId, sessionId, parentTurnId, modelName, modelProvider);
        // 执行 ID 在 prepare 阶段就已生成，这里直接落库：观察钩子只给 executionId，
        // 若不在此刻写入，START 事件到达时就找不回本轮次（会永远停在 ACCEPTED）。
        turn.attachExecution(executionId);
        chatTurnRepository.save(turn);
        return turnId;
    }

    @Override
    @Transactional
    public void markRunning(String executionId, Instant startedAt) {
        mutate(executionId, "markRunning", turn -> turn.markRunning(startedAt));
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
    public void markWaiting(String executionId) {
        mutate(executionId, "markWaiting", ChatTurn::markWaiting);
    }

    @Override
    @Transactional
    public void markTerminal(String executionId, ChatTurnStatus terminalStatus,
                             Long inputTokens, Long outputTokens, Long totalTokens, Instant completedAt) {
        if (terminalStatus == null || !terminalStatus.isTerminal()) {
            throw new IllegalArgumentException("markTerminal 只接受终态，收到: " + terminalStatus);
        }
        mutate(executionId, "markTerminal/" + terminalStatus,
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
    public void refreshUsage(String executionId, Long inputTokens, Long outputTokens, Long totalTokens) {
        if (inputTokens == null && outputTokens == null && totalTokens == null) {
            return;
        }
        mutate(executionId, "refreshUsage",
                turn -> turn.refreshUsage(inputTokens, outputTokens, totalTokens));
    }

    @Override
    @Transactional
    public void recordFailureReason(String executionId, String reason) {
        if (reason == null || reason.isBlank()) {
            return;
        }
        mutate(executionId, "recordFailureReason", turn -> turn.recordFailureReason(reason));
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

    /**
     * 按执行 ID 找到轮次并施加一次变更；找不到就跳过。
     *
     * <p>归属解析走 {@code execution_id} 的唯一键，**不按「会话最新执行」反查** ——
     * 并发下那样必然认错轮次。执行 ID 非数字（框架兜底 UUID 路径）同样跳过。</p>
     *
     * <p>领域方法抛出的非法转移异常不在这里吞掉：它代表真实的状态机违约，
     * 应当暴露出来（观察钩子自身有 try/catch 兜底，不会打断主链路）。</p>
     */
    private void mutate(String executionId, String action, Consumer<ChatTurn> mutation) {
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
        chatTurnRepository.updateById(turn);
    }
}

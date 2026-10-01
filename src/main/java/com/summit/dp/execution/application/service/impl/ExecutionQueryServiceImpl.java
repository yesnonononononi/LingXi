package com.summit.dp.execution.application.service.impl;

import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 批量读取执行领域模型，将持久化状态编码转换为框架已有的执行状态。 */
@Service
@RequiredArgsConstructor
public class ExecutionQueryServiceImpl implements ExecutionQueryService {

    private final ExecutionRepository executionRepository;

    @Override
    public Map<Long, List<ExecutionState>> latestStatesBySession(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return Map.of();
        List<Execution> executions = executionRepository.findLatestBySessionAndStatus(sessionIds);
        Map<Long, List<ExecutionState>> result = new LinkedHashMap<>();
        // 仓储按每会话内 id 降序返回；分组保持此顺序。
        for (Execution execution : executions) {
            result.computeIfAbsent(execution.getSessionId(), key -> new ArrayList<>())
                    .add(toState(execution));
        }
        return result;
    }

    /** 固定编码映射，不依赖框架枚举的声明顺序；异常数据不能伪装成 IDLE。 */
    private static ExecutionState toState(Execution execution) {
        Integer status = execution.getStatus();
        return switch (status) {
            case 0 -> ExecutionState.CREATED;
            case 1 -> ExecutionState.RUNNING;
            case 2 -> ExecutionState.SUSPENDED;
            case 3 -> ExecutionState.COMPLETED;
            case 4 -> ExecutionState.FAILED;
            case 5 -> ExecutionState.CANCELLED;
            case null, default -> throw new IllegalStateException(
                    "Unknown execution status " + status + " for execution " + execution.getId());
        };
    }

    /**
     * 批量装配执行摘要。仓储层一次 IN 查询完成，不逐条查；仓储已排除 snapshot。
     *
     * <p>状态编码经 {@link #toState} 转成框架枚举名下发 —— 与 {@code latestStatesBySession}
     * 用同一套映射，避免两处口径漂移。</p>
     *
     * <p>只装配框架自己的运行记录；模型与 token 是业务事实，由 {@code chat_turn} 承载。</p>
     */
    @Override
    public Map<Long, ExecutionSummary> summariesByIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) return Map.of();
        List<Execution> executions = executionRepository.findSummariesByIds(executionIds);
        Map<Long, ExecutionSummary> result = new LinkedHashMap<>();
        for (Execution execution : executions) {
            result.put(execution.getId(), new ExecutionSummary(
                    execution.getId(),
                    execution.getSessionId(),
                    toState(execution).name(),
                    toInstant(execution.getStartedAt()),
                    toInstant(execution.getCompletedAt())));
        }
        return result;
    }

    /** 库列是无时区的 {@code DATETIME}，按本机时区解释 —— 与写入侧同一口径，往返一致。 */
    private static Instant toInstant(LocalDateTime value) {
        return value == null ? null : value.atZone(ZoneId.systemDefault()).toInstant();
    }
}

package com.summit.dp.execution.application.service.impl;

import com.summit.dp.execution.domain.model.ExecutionStatus;
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

/** 批量读取执行领域模型，按固定编码提供业务查询状态。 */
@Service
@RequiredArgsConstructor
public class ExecutionQueryServiceImpl implements ExecutionQueryService {

    private final ExecutionRepository executionRepository;

    @Override
    public Map<Long, List<ExecutionStatus>> latestStatesBySession(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return Map.of();
        List<Execution> executions = executionRepository.findLatestBySessionAndStatus(sessionIds);
        Map<Long, List<ExecutionStatus>> result = new LinkedHashMap<>();
        // 仓储按每会话内 id 降序返回；分组保持此顺序。
        for (Execution execution : executions) {
            result.computeIfAbsent(execution.getSessionId(), key -> new ArrayList<>())
                    .add(toState(execution));
        }
        return result;
    }

    /** 固定编码映射，不依赖枚举的声明顺序；异常数据不能伪装成 IDLE。 */
    private static ExecutionStatus toState(Execution execution) {
        Integer status = execution.getStatus();
        return switch (status) {
            case 0 -> ExecutionStatus.CREATED;
            case 1 -> ExecutionStatus.RUNNING;
            case 2 -> ExecutionStatus.SUSPENDED;
            case 3 -> ExecutionStatus.COMPLETED;
            case 4 -> ExecutionStatus.FAILED;
            case 5 -> ExecutionStatus.CANCELLED;
            case null, default -> throw new IllegalStateException(
                    "执行状态编码无法识别: status=" + status + ", executionId=" + execution.getId());
        };
    }

    /**
     * 批量装配执行摘要。仓储层一次 IN 查询完成，不逐条查；仓储已排除 snapshot。
     *
     * <p>状态编码经 {@link #toState} 转成业务状态名下发 —— 与 {@code latestStatesBySession}
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

    @Override
    public String findSnapshotById(Long executionId) {
        return executionRepository.findById(executionId).map(Execution::getSnapshot).orElse(null);
    }

    /**
     * 批量取未终结执行（CREATED/RUNNING/SUSPENDED），带执行身份。
     *
     * <p>仓储层一次 {@code IN} 查询（状态条件走 {@code IN (0,1,2)}），不逐会话查；
     * 状态经 {@link #toState} 转成业务状态名，与其余方法同一口径。</p>
     */
    @Override
    public List<ActiveExecution> activeBySession(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return List.of();
        return executionRepository.findUnfinishedBySessions(sessionIds).stream()
                .map(execution -> new ActiveExecution(
                        execution.getId(),
                        execution.getSessionId(),
                        toState(execution).name(),
                        toInstant(execution.getStartedAt()),
                        toInstant(execution.getCompletedAt())))
                .toList();
    }

    /** 库列是无时区的 {@code DATETIME}，按本机时区解释 —— 与写入侧同一口径，往返一致。 */
    private static Instant toInstant(LocalDateTime value) {
        return value == null ? null : value.atZone(ZoneId.systemDefault()).toInstant();
    }
}

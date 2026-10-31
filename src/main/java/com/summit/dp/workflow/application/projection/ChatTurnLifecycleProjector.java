package com.summit.dp.workflow.application.projection;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * 只投影已提交的生命周期事实，挂起与终态不能互相覆盖。
 *
 * <p><b>为什么这里要整笔事务重试</b>：轮次投影是「按 execution_id 读轮次 → 领域方法改状态 →
 * 写回」，属于读后写。同一排空周期里多个执行（子代理并发结束、挂起与终态交错）可能同时投影，
 * 后写的一方在 SQLite 上会撞 {@code SQLITE_BUSY_SNAPSHOT} —— 只重试 UPDATE 无效，
 * 必须在全新事务里重新读一遍。共用 {@link TransactionRetryTemplate}，与检查点保存、
 * 会话上下文替换是同一套判定。调用方已有事务时不另开事务（那只跑一次，原子性归调用方）。</p>
 */
@Component
@RequiredArgsConstructor
public class ChatTurnLifecycleProjector {
    private final ChatTurnService chatTurnService;

    /** 事务管理器：可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，只跑一次。 */
    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    /** 投影的重试器；惰性创建后复用同一实例以累计指标。 */
    private TransactionRetryTemplate projectionRetry;

    public void markExecutionWaiting(Execution execution) {
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        retryTemplate().execute(() -> {
            chatTurnService.markWaiting(execution.getId(), rootSessionId);
            return null;
        });
    }

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
        retryTemplate().execute(() -> {
            chatTurnService.markTerminal(execution.getId(), terminalStatus, null, null, null,
                    execution.getCompletedAt(), rootSessionId);
            return null;
        });
    }

    /** 惰性创建重试器：事务管理器可选注入，创建后复用同一实例。 */
    private synchronized TransactionRetryTemplate retryTemplate() {
        if (projectionRetry == null) {
            projectionRetry = new TransactionRetryTemplate(transactionManager, "投影轮次生命周期");
        }
        return projectionRetry;
    }
}

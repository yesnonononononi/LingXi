package com.summit.dp.workflow.application.chat;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.Set;

/** 停止先关闭登记；一次批量查询补齐重启后尚未加载的执行。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionExecutionStopper {
    private final SessionRepository sessions;
    private final ExecutionRepository executions;
    private final SessionExecutionRegistry registry;
    private final ExecutionControl control;
    private final PendingChatQueue pendingChats;

    public void stop(long rootSessionId) {
        Set<String> executionIds;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            pendingChats.pause(rootSessionId);
            executionIds = new LinkedHashSet<>(registry.cancelRoot(rootSessionId));
            Set<Long> sessionIds = new LinkedHashSet<>();
            sessionIds.add(rootSessionId);
            sessions.findSessionTree(rootSessionId).stream().map(Session::getId).forEach(sessionIds::add);
            for (Execution execution : executions.findUnfinishedBySessions(sessionIds)) {
                String executionId = String.valueOf(execution.getId());
                registry.restoreExecution(rootSessionId, execution.getSessionId(), executionId);
                executionIds.add(executionId);
            }
        }
        // 运行线程按执行锁提交检查点，不能持根登记锁等待它收尾。
        IllegalStateException persistenceFailure = null;
        for (String executionId : executionIds) {
            try {
                control.cancel(executionId);
            } catch (IllegalStateException failure) {
                // 批量读取之后可能已终结，未建行的排队任务则由槽位取消标记拦截；但落库失败不能吞掉。
                log.warn("停止执行跳过或失败: rootSessionId={}, executionId={}, error={}",
                        rootSessionId, executionId, failure.getMessage());
                if (isPersistenceFailure(failure) && persistenceFailure == null) {
                    persistenceFailure = failure;
                }
            }
        }
        if (persistenceFailure != null) {
            throw persistenceFailure;
        }
    }

    private static boolean isPersistenceFailure(IllegalStateException failure) {
        return failure.getCause() != null
                || (failure.getMessage() != null && failure.getMessage().contains("保存执行检查点失败"));
    }
}

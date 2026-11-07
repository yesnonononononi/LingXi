package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 「还有没有未完成的子执行」的唯一判定点。
 *
 * <p>两级证据：进程内登记表覆盖正在跑的子执行；持久化状态覆盖进程重启后登记表为空的窗口。</p>
 *
 * <p><b>为什么单独成类</b>：恢复门禁与循环拦截器（收尾前要不要挂起）问的是同一个问题，
 * 两处各写一份必然漂移。</p>
 */
@Component
@RequiredArgsConstructor
public class SubExecutionDependency {

    private final SessionExecutionRegistry registry;
    private final SessionRepository sessions;
    private final ExecutionRepository executions;

    /**
     * 该执行是否还有未完成的子执行。
     *
     * <p>执行自身就是子执行时恒为 {@code false}：子执行等的是自己的父，不是别人。</p>
     */
    public boolean hasUnfinishedSubExecution(Execution execution) {
        if (execution == null) {
            return false;
        }
        if (ExecutionAttributes.readLong(execution.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes(), ExecutionAttributes.ROOT_EXECUTION_ID) != null) {
            return false;
        }
        long sessionId = ExecutionIdentity.sessionId(execution);
        if (registry.hasUnfinishedChildren(sessionId)) {
            return true;
        }
        List<Long> children = sessions.findSessionTree(sessionId).stream()
                .map(session -> session.getId()).filter(id -> id != sessionId).toList();
        return !children.isEmpty() && !executions.findUnfinishedBySessions(children).isEmpty();
    }
}

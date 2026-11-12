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
 * <p><b>它回答的是「收尾要不要继续等」，不是「能不能恢复」</b>：子代理终态本身就是唤醒根执行的
 * 理由，用「兄弟子会话还在跑」去拦唤醒，会把已到位的交付压到最后一个子会话结束。恢复准入只剩
 * 用户暂停、自动轮次上限与未决卡片三道门禁。判定仍然只有一个实现：拦截器（收尾挂起）与
 * 通道（有没有未完结的异步依赖）问的是同一个问题，两处各写一份必然漂移。</p>
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

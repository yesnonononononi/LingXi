package com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.application.input.InputSource;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/** 子执行交付归邮件来源；本来源只阻止依赖未结束时收尾。 */
@Component
@RequiredArgsConstructor
public class SubExecutionInputSource implements InputSource<Void> {
    private final SessionExecutionRegistry registry;
    private final SessionRepository sessions;
    private final ExecutionRepository executions;

    @Override
    public List<Void> pendingItems(Execution execution) {
        return List.of();
    }

    @Override
    public boolean hasOpenDependency(Execution execution) {
        if (ExecutionAttributes.readLong(execution.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes(), ExecutionAttributes.ROOT_EXECUTION_ID) != null) return false;
        long sessionId = ExecutionIdentity.sessionId(execution);
        if (registry.hasUnfinishedChildren(sessionId)) return true;
        // 待启动登记覆盖尚未落库的窗口，持久化状态覆盖进程重启后的空注册表。
        List<Long> children = sessions.findSessionTree(sessionId).stream()
                .map(session -> session.getId()).filter(id -> id != sessionId).toList();
        return !children.isEmpty() && !executions.findUnfinishedBySessions(children).isEmpty();
    }
}

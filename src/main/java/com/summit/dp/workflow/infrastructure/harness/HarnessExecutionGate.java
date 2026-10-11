package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.toolcall.application.port.ExecutionGateQuery;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy.ExecutionGate;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/** 先判控制槽位再读已提交快照，保持展示与决策共用同一口径。 */
@Component
@RequiredArgsConstructor
public class HarnessExecutionGate implements ExecutionGateQuery {
    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;

    @Override
    public boolean isActive(String executionId) {
        return activity.getObject().isActive(executionId);
    }

    @Override
    public ExecutionGate resolveGate(String executionId) {
        if (isActive(executionId)) return ExecutionGate.ACTIVE;
        Execution execution = executions.getObject().findById(executionId).orElse(null);
        if (execution == null) return ExecutionGate.UNKNOWN;
        return execution.getExecutionState() == ExecutionState.SUSPENDED
                ? ExecutionGate.SUSPENDED : ExecutionGate.NOT_SUSPENDED;
    }
}

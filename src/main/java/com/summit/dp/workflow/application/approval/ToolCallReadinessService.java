package com.summit.dp.workflow.application.approval;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;

/** 卡片开放必须晚于检查点提交和旧信号释放。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ToolCallReadinessService {
    private final ToolCallRepository tools;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;

    public void markReady(String executionId) {
        synchronized (ExecutionCoordination.monitor(executionId)) {
            ExecutionRepository repository = executions.getObject();
            Execution execution = repository.findById(executionId).orElse(null);
            if (execution == null || execution.getExecutionState() != ExecutionState.SUSPENDED
                    || activity.getObject().isActive(executionId)) return;
            List<ToolCall> ready = new ArrayList<>();
            TransactionTemplate readinessTransaction = new TransactionTemplate(transactions.getTransactionManager());
            readinessTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            readinessTransaction.executeWithoutResult(status -> {
                for (ToolCall tool : tools.listUnresolvedByExecutionId(Long.valueOf(executionId))) {
                    if (tool.markReady()) {
                        tools.updateById(tool);
                        ready.add(tool);
                    }
                }
            });
        }
    }
}

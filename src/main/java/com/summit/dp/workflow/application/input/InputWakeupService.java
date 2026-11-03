package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 提交和状态转换都只触发复查，检查失败不冒充空输入。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class InputWakeupService {
    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;
    private final InputResolver inputs;
    private final InputAutomationPolicy policy;
    private final InputNoticeReporter notices;
    private final ObjectProvider<ExecutionResumeCoordinator> resumes;
    private final ObjectProvider<InputTurnContinuation> continuations;
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    public CompletableFuture<Void> resumeIfInputPending(long executionId) {
        return CompletableFuture.runAsync(() -> {
            Execution completed = null;
            synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
                Execution execution = null;
                String batchKey = null;
                RuntimeException queryFailure = null;
                for (int attempt = 0; attempt < 2; attempt++) {
                    try {
                        execution = executions.getObject().findById(String.valueOf(executionId)).orElse(null);
                        if (execution == null) return;
                        if (activity.getObject().isActive(String.valueOf(executionId))) return;
                        batchKey = inputs.pendingBatchKey(execution);
                        queryFailure = null;
                        break;
                    } catch (RuntimeException failure) {
                        queryFailure = failure;
                    }
                }
                if (queryFailure != null) {
                    notices.reportQueryFailure(executionId, "输入复查失败，未自动启动：" + queryFailure.getMessage());
                    log.error("输入复查失败: executionId={}", executionId, queryFailure);
                    return;
                }
                if (batchKey == null) return;
                String reason = policy.blockedReason(execution);
                if (reason != null) {
                    notices.report(execution, batchKey, reason);
                    return;
                }
                if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
                    resumes.getObject().accept(executionId);
                } else if (execution.getExecutionState() == ExecutionState.COMPLETED) {
                    completed = execution;
                }
            }
            // 新轮受理会创建另一执行，不能持旧执行门闩再取新执行门闩。
            if (completed != null) continuations.getObject().continueTurn(completed);
        }, workers).whenComplete((ignored, failure) -> {
            if (failure != null) log.error("输入自动处理失败: executionId={}", executionId, failure);
        });
    }

    @PreDestroy
    public void close() {
        workers.shutdownNow();
    }
}

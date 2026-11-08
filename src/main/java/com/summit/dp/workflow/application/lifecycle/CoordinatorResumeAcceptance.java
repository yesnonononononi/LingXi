package com.summit.dp.workflow.application.lifecycle;

import com.summit.dp.execution.application.service.ResumeDisposition;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 恢复端口的唯一实现：只做转交，不重复任何判定。
 *
 * <p>门禁、代际、派发标记全部留在 {@link ExecutionResumeCoordinator} —— 它是恢复运行时唯一的
 * 消费口。这里多一行判断，就会出现两套口径。</p>
 */
@Component
@RequiredArgsConstructor
public class CoordinatorResumeAcceptance implements ResumeAcceptancePort, ResumeDispatchPort {

    private final ExecutionResumeCoordinator coordinator;

    @Override
    public ResumeDisposition accept(long executionId, ResumeTriggerType trigger) {
        return coordinator.accept(executionId, trigger);
    }

    @Override
    public ResumeDisposition accept(long executionId, ResumeTriggerType trigger, Runnable onSettled) {
        return coordinator.accept(executionId, trigger, onSettled);
    }

    @Override
    public void redispatch(long executionId) {
        coordinator.dispatch(executionId);
    }

    @Override
    public void closeStartupFailure(long executionId, String reason) {
        coordinator.closeStartupFailure(executionId, reason);
    }
}

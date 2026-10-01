package com.summit.dp.execution.application.service.impl;

import com.summit.dp.execution.application.service.ExecutionRegistrationService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

/** 初始执行登记实现：只写「会话/根执行归属 + 状态」，不写 snapshot（snapshot 归框架检查点）。 */
@Service
@RequiredArgsConstructor
public class ExecutionRegistrationServiceImpl implements ExecutionRegistrationService {

    /** execution.status 取值，与框架 {@code ExecutionState} 序号一一对应。 */
    private static final int STATUS_CREATED = 0;

    private final ExecutionRepository executionRepository;

    @Override
    public void registerInitial(InitialExecution initial) {
        Execution execution = new Execution();
        execution.setId(initial.executionId());
        execution.setSessionId(initial.sessionId());
        execution.setRootExecutionId(initial.rootExecutionId());
        execution.setStatus(STATUS_CREATED);
        // 刻意不写 snapshot：执行恢复检查点是框架的职责，这里只登记「这次执行存在」。
        // 模型与用量也不写 —— 它们是业务事实，权威在 chat_turn（模型受理时写入、用量完成事件回填）。
        executionRepository.save(execution);
    }

    @Override
    public boolean markStartupFailed(long executionId) {
        return executionRepository.markFailedIfUnfinished(executionId, LocalDateTime.now()) == 1;
    }
}

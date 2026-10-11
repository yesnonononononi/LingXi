package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.dp.execution.application.port.ExecutionLock;
import org.springframework.stereotype.Component;

/** 业务端口与框架适配共用锁，迁移不能拆成两组互不协调的门闩。 */
@Component
public class LocalExecutionLock implements ExecutionLock {
    @Override
    public Object monitor(String executionId) {
        return ExecutionCoordination.monitor(executionId);
    }
}

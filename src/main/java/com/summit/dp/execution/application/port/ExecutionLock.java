package com.summit.dp.execution.application.port;

/** 检查点、卡片收口和恢复必须共用同一把执行锁。 */
public interface ExecutionLock {
    Object monitor(String executionId);
}

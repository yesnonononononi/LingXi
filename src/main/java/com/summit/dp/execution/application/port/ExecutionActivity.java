package com.summit.dp.execution.application.port;

/** 就绪与恢复只能发生在旧控制信号释放后。 */
public interface ExecutionActivity {
    boolean isActive(String executionId);
}

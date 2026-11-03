package com.summit.dp.workflow.infrastructure.harness;

/** 收尾期间暂存线程中断，避免检查点和数据库只提交一半；退出后恢复停止意图。 */
final class ExecutionPersistenceScope implements AutoCloseable {
    private final boolean interrupted;

    private ExecutionPersistenceScope() {
        interrupted = Thread.interrupted();
    }

    static ExecutionPersistenceScope open() {
        return new ExecutionPersistenceScope();
    }

    @Override
    public void close() {
        if (interrupted) Thread.currentThread().interrupt();
    }
}

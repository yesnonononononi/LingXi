package com.summit.dp.execution.domain.model;

/** 查询状态独立于框架生命周期类型，序号不能用于持久化编码。 */
public enum ExecutionStatus {
    CREATED, RUNNING, SUSPENDED, COMPLETED, FAILED, CANCELLED;

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == CANCELLED;
    }
}

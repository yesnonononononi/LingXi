package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.core.runtime.loop.ExecutionControlSignal;

/** 取消属于整个执行；暂停和运行占用只属于一次运行。 */
public final class ExecutionControlSlot {
    private final String executionId;
    private Long rootSessionId;
    private Long sessionId;
    private boolean cancelled;
    private boolean committed;
    private boolean finished;
    private ExecutionControlSignal running;

    ExecutionControlSlot(String executionId) {
        this.executionId = executionId;
    }

    public String executionId() { return executionId; }
    public synchronized Long sessionId() { return sessionId; }
    synchronized Long rootSessionId() { return rootSessionId; }
    synchronized boolean isCommitted() { return committed; }
    synchronized boolean isFinished() { return finished; }
    public synchronized boolean isRunning() { return running != null; }
    public synchronized boolean isCancelled() { return cancelled; }
    synchronized boolean isSuspendRequired() { return running != null && running.isSuspendRequired(); }

    synchronized void attach(Long rootSessionId, Long sessionId) {
        if (this.rootSessionId != null && (!this.rootSessionId.equals(rootSessionId)
                || !this.sessionId.equals(sessionId))) {
            throw new IllegalStateException("执行的会话归属不能改变: executionId=" + executionId);
        }
        this.rootSessionId = rootSessionId;
        this.sessionId = sessionId;
    }

    synchronized void record(boolean finished) {
        committed = true;
        this.finished |= finished;
    }

    public synchronized void requireCancel() {
        cancelled = true;
        if (running != null) running.requireCancel();
    }

    synchronized ExecutionControlSignal acquire() {
        if (finished) throw new IllegalStateException("执行已结束，不能重新运行: executionId=" + executionId);
        if (running != null) throw new IllegalStateException("执行已在运行: executionId=" + executionId);
        running = new ExecutionControlSignal(executionId);
        if (cancelled) running.requireCancel();
        return running;
    }

    synchronized boolean release(ExecutionControlSignal signal) {
        if (running != signal) return false;
        if (signal.isCancelRequired()) cancelled = true;
        running = null;
        return true;
    }

    synchronized boolean requireSuspend() {
        if (running == null) return false;
        running.requireSuspend();
        return true;
    }
}

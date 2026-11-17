package com.summit.dp.workflow.application.turn;

import com.summit.core.agent.ExecutionState;

/**
 * 「上一轮结束了」的事实。
 *
 * @param sessionId     执行所属会话（子执行就是子会话）
 * @param rootSessionId 根会话
 * @param executionId   刚结束的执行
 * @param terminalState 终态；执行对象缺失时为 null
 * @param failure       失败原因文本，正常结束为 null
 */
public record TurnPostEndContext(long sessionId, long rootSessionId, String executionId,
                                 ExecutionState terminalState, String failure) {

    /** 只有正常完成才谈得上「可以接力」：失败、被停止、挂起都不该自动往下跑。 */
    public boolean completed() {
        return terminalState == ExecutionState.COMPLETED && failure == null;
    }
}

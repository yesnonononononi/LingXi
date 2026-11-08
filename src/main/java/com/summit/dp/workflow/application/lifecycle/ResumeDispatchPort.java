package com.summit.dp.workflow.application.lifecycle;

/**
 * 恢复重投端口：启动巡检按库内来源重投、无控制槽位时的启动失败收口。
 *
 * <p>只为「重投动作的唯一消费口在 lifecycle」这条边界存在 —— 它转交的还是协调器那一个
 * {@code dispatch}，没有第二套派发、没有第二套门禁。启动巡检属基础设施，不该直接持有协调器。</p>
 */
public interface ResumeDispatchPort {

    /**
     * 唤醒 worker 处理某执行上的恢复请求。
     *
     * @param executionId 执行 ID
     */
    void redispatch(long executionId);

    /**
     * 收口「启动即失败」且没有控制槽位可释放的执行。
     *
     * @param executionId 执行 ID
     * @param reason      失败原因（用户可见文案）
     */
    void closeStartupFailure(long executionId, String reason);
}

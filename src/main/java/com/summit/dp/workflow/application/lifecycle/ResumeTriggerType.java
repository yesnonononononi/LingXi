package com.summit.dp.workflow.application.lifecycle;

/**
 * 恢复触发来源：决定门禁怎么判、以及能否清理人的暂停意图。
 *
 * <p><b>为什么只有手动触发能清标记</b>：{@code USER_PAUSED} 是人的意图，机器唤醒
 * （外部输入、审批回执、崩溃恢复）不能替人取消它，否则「我按了暂停，它自己又跑起来」。</p>
 */
public enum ResumeTriggerType {

    /** 用户手动 {@code /resume}：同步预检 + 同步恢复，允许覆盖暂停。 */
    MANUAL_USER_RESUME(true),

    /** 审批 / 多选 / 命令决议落定后的恢复：走队列。 */
    APPROVAL_DECISION(false),

    /** 外部输入（邮件 / 后台任务 / 子代理结果）到位的自动唤醒：走队列。 */
    AUTO_INPUT_WAKEUP(false),

    /** 进程启动时对遗留请求的收口：只失败收口，不重投。 */
    STARTUP_RECOVERY(false);

    private final boolean clearsPauseMarkers;

    ResumeTriggerType(boolean clearsPauseMarkers) {
        this.clearsPauseMarkers = clearsPauseMarkers;
    }

    /** 是否允许清理 {@code USER_PAUSED} / {@code AUTO_ROUNDS}：只有手动恢复为真。 */
    public boolean clearsPauseMarkers() {
        return clearsPauseMarkers;
    }
}

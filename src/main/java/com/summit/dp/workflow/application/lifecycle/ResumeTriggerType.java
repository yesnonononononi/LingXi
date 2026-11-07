package com.summit.dp.workflow.application.lifecycle;

import com.summit.dp.execution.domain.model.ResumeSource;

/**
 * 恢复触发来源：决定门禁怎么判、以及能否清理人的暂停意图。
 *
 * <p><b>为什么只有手动触发能清标记</b>：{@code USER_PAUSED} 是人的意图，机器唤醒
 * （外部输入、审批回执、崩溃恢复）不能替人取消它，否则「我按了暂停，它自己又跑起来」。</p>
 */
public enum ResumeTriggerType {

    /** 用户手动 {@code /resume}：同步预检 + 同步恢复，允许覆盖暂停。 */
    MANUAL_USER_RESUME(true, true),

    /** 审批 / 多选 / 命令决议落定后的恢复：走队列。 */
    APPROVAL_DECISION(false, true),

    /** 外部输入（邮件 / 后台任务 / 子代理结果）到位的自动唤醒：走队列。 */
    AUTO_INPUT_WAKEUP(false, false),

    /** 进程启动时对遗留请求的收口：只失败收口，不重投。 */
    STARTUP_RECOVERY(false, false);

    private final boolean clearsPauseMarkers;

    private final boolean humanInitiated;

    ResumeTriggerType(boolean clearsPauseMarkers, boolean humanInitiated) {
        this.clearsPauseMarkers = clearsPauseMarkers;
        this.humanInitiated = humanInitiated;
    }

    /** 是否允许清理 {@code USER_PAUSED} / {@code AUTO_ROUNDS}：只有手动恢复为真。 */
    public boolean clearsPauseMarkers() {
        return clearsPauseMarkers;
    }
    /**
     * 本次恢复是否由人做出（手动恢复、审批 / 多选 / 命令决议）。
     *
     * <p><b>为什么与 {@link #clearsPauseMarkers()} 分开</b>：两件事的边界不同。清标记是
     * 「人撤销了自己的暂停」，只有手动恢复；而{@code AUTO_ROUNDS} 上限是防机器无限自转的闸门，
     * 它约束的是「机器自己接续」，人工决策不该被它挡住 —— 否则连续自动接续满 3 轮后，
     * 用户点批准会被静默作废，执行永远停在挂起态。混用一个判据必然在其中一边判错。</p>
     */
    public boolean humanInitiated() {
        return humanInitiated;
    }

    /**
     * 持久化口径：把「门禁怎么判」的策略来源写成恢复请求行上的来源。
     *
     * <p>映射就放在这里，因为只有本包能同时看到两个枚举；领域层因此不必反向依赖应用层。
     * 两边是否一一对应由 {@code ResumeTriggerSourceMappingTest} 守着 —— 新增一个触发来源
     * 却忘了映射，那条用例会红。</p>
     */
    public ResumeSource persisted() {
        return switch (this) {
            case MANUAL_USER_RESUME -> ResumeSource.MANUAL_USER_RESUME;
            case APPROVAL_DECISION -> ResumeSource.APPROVAL_DECISION;
            case AUTO_INPUT_WAKEUP -> ResumeSource.AUTO_INPUT_WAKEUP;
            case STARTUP_RECOVERY -> ResumeSource.STARTUP_RECOVERY;
        };
    }

    /** 反向映射：消费端按库里的来源复检门禁时用。 */
    public static ResumeTriggerType of(ResumeSource source) {
        if (source == null) {
            return AUTO_INPUT_WAKEUP;
        }
        return switch (source) {
            case MANUAL_USER_RESUME -> MANUAL_USER_RESUME;
            case APPROVAL_DECISION -> APPROVAL_DECISION;
            case AUTO_INPUT_WAKEUP -> AUTO_INPUT_WAKEUP;
            case STARTUP_RECOVERY -> STARTUP_RECOVERY;
        };
    }
}

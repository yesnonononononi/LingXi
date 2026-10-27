package com.summit.dp.checklist.domain.model;

/**
 * 清单生命周期状态。
 *
 * <p>只有 {@link #ACTIVE} 持有「本会话唯一活动清单」的数据库唯一键（派生列 active_session_key），
 * 其余状态一律把该键置 NULL，从而把唯一额度让给下一份清单。</p>
 */
public enum ChecklistStatus {

    /** 执行中：可改标题、改步骤、推进步骤状态 */
    ACTIVE,
    /** 所有步骤都已进入终态（含 FAILED / SKIPPED）；完成表示已收口，不表示全部成功 */
    COMPLETED,
    /** 提醒额度用尽仍无实际推进，被收尾判定关闭；保留现场供人复核 */
    UNFINISHED,
    /** 显式软删；历史不被物理清除 */
    DELETED;

    /** 是否已离开 ACTIVE：终态清单不再接受任何修改，需要重试时新建清单。 */
    public boolean isTerminal() {
        return this != ACTIVE;
    }

    /** 是否为软删状态：它同时是「不可再修改」的最强约束。 */
    public boolean isDeleted() {
        return this == DELETED;
    }
}

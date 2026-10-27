package com.summit.dp.checklist.domain.model;

/** 单个步骤的终态取值：只有 PENDING 能前进到这三种结果，之后不可回退。 */
public enum ChecklistStepStatus {

    /** 待处理：唯一可以推进的状态；也是提醒唯一关心的状态 */
    PENDING,
    /** 已完成 */
    COMPLETED,
    /** 已失败：属于步骤级结果，不阻止清单收口，但不会被伪装成成功 */
    FAILED,
    /** 已跳过：属于步骤级结果，不阻止清单收口 */
    SKIPPED;

    /** 是否为终态：终态步骤不接受再次变更。 */
    public boolean isTerminal() {
        return this != PENDING;
    }
}

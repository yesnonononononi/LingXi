package com.summit.dp.checklist.domain.model;

/** 进行中不算完成；终态一旦写入便不可回退。 */
public enum ChecklistStepStatus {

    /** 待处理：唯一可以推进的状态；也是提醒唯一关心的状态 */
    PENDING,
    /** 模型已明确开始处理 */
    IN_PROGRESS,
    /** 已完成 */
    COMPLETED,
    /** 已失败：属于步骤级结果，不阻止清单收口，但不会被伪装成成功 */
    FAILED,
    /** 已跳过：属于步骤级结果，不阻止清单收口 */
    SKIPPED;

    /** 是否为终态：终态步骤不接受再次变更。 */
    public boolean isTerminal() {
        return this != PENDING && this != IN_PROGRESS;
    }
}

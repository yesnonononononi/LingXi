package com.summit.dp.checklist.domain.model;

import java.util.List;

/**
 * 一次领域变更造成的持久化影响面。
 *
 * <p>聚合不直接持有 Mapper，服务层靠这份清单精确落库：
 * 「哪些行要删、哪些行要写、清单行本身要不要更新」由此显式表达，
 * 避免用「把整棵树 update 一遍」掩盖漏删或漏重算状态的缺陷。</p>
 *
 * @param checklistChanged 清单行（状态、进度版本、提醒字段、标题）是否需要更新
 * @param removedStepIds   需要删除的步骤标识
 * @param changedSteps     需要更新的既有步骤（状态、内容或 seq 发生变化）
 * @param addedSteps       需要新增的步骤
 */
public record ChecklistMutation(
        boolean checklistChanged,
        List<Long> removedStepIds,
        List<ChecklistStep> changedSteps,
        List<ChecklistStep> addedSteps) {

    /** 什么都没变：重复提交相同状态、空补丁都走这里。 */
    public static ChecklistMutation none() {
        return new ChecklistMutation(false, List.of(), List.of(), List.of());
    }
}

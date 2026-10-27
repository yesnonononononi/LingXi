package com.summit.dp.checklist.domain.model;

import java.util.List;
import java.util.Map;

/**
 * 一次结构修改的补丁描述。
 *
 * <p>刻意做成显式补丁：请求里没出现的步骤<b>不</b>等于删除，
 * 否则模型少写一个字段就会静默丢步骤。所有集合都允许为 {@code null}（表示「本次不动这一项」）。</p>
 *
 * @param title           新的标题，{@code null} 或空白表示不改
 * @param contentUpdates  步骤标识 → 新内容；保留步骤原状态
 * @param addedSteps      要追加的新步骤（标识由应用层生成），一律 PENDING
 * @param removedStepIds  要删除的步骤标识
 * @param orderedStepIds  修改完成后的完整顺序（必须恰好覆盖所有保留与新步骤），{@code null} 表示沿用现有顺序
 */
public record ChecklistModification(
        String title,
        Map<Long, String> contentUpdates,
        List<NewStep> addedSteps,
        List<Long> removedStepIds,
        List<Long> orderedStepIds) {

    /** 追加步骤：标识与内容成对出现，避免顺序错配。 */
    public record NewStep(Long id, String content) {
    }

    /** 无操作的补丁：全部为 null/空。 */
    public static ChecklistModification empty() {
        return new ChecklistModification(null, Map.of(), List.of(), List.of(), null);
    }
}

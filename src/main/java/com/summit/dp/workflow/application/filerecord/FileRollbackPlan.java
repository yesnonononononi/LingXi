package com.summit.dp.workflow.application.filerecord;

import java.util.List;

/**
 * 一次执行的完整回滚计划。
 *
 * <p>计划先算全、再动盘：门禁是逐文件判定的，边算边写会让「一半文件已经回填、另一半被拒」
 * 变成没人能解释的中间态。</p>
 *
 * @param executionId 执行标识
 * @param items       每个文件一行，顺序沿用记录写入顺序
 */
public record FileRollbackPlan(String executionId, List<FileRollbackItem> items) {

    public FileRollbackPlan {
        items = List.copyOf(items);
    }

    /** 会动盘的那些行。 */
    public List<FileRollbackItem> actionable() {
        return this.items.stream().filter(FileRollbackItem::actionable).toList();
    }

    public boolean hasAction() {
        return !this.actionable().isEmpty();
    }
}

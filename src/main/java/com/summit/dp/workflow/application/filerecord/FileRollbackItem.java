package com.summit.dp.workflow.application.filerecord;

/**
 * 回滚计划里的一行。
 *
 * @param filePath 绝对路径（记录里的原样路径）
 * @param action   要做的动作
 * @param reason   跳过原因；能执行时为 {@code null}
 * @param baseline 基线原文；只有 {@link FileRollbackAction#RESTORE} 才有
 * @param recordId 来源记录标识（回滚备份按它命名）
 */
public record FileRollbackItem(String filePath, FileRollbackAction action, String reason,
                               String baseline, String recordId) {

    public static FileRollbackItem restore(String filePath, String baseline, String recordId) {
        return new FileRollbackItem(filePath, FileRollbackAction.RESTORE, null, baseline, recordId);
    }

    public static FileRollbackItem delete(String filePath, String recordId) {
        return new FileRollbackItem(filePath, FileRollbackAction.DELETE, null, null, recordId);
    }

    public static FileRollbackItem skip(String filePath, String reason, String recordId) {
        return new FileRollbackItem(filePath, FileRollbackAction.SKIP, reason, null, recordId);
    }

    /** 这一行会不会动盘。 */
    public boolean actionable() {
        return this.action != FileRollbackAction.SKIP;
    }
}

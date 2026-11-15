package com.summit.dp.workflow.application.filerecord;

/**
 * 单个文件的实际处理结果。
 *
 * @param filePath   绝对路径
 * @param action     实际执行的动作
 * @param success    是否成功
 * @param message    失败原因；成功时为 {@code null}
 * @param backupPath 回滚前备份的绝对路径；没有备份时为 {@code null}
 */
public record FileRollbackOutcome(String filePath, FileRollbackAction action, boolean success,
                                  String message, String backupPath) {

    public static FileRollbackOutcome done(String filePath, FileRollbackAction action, String backupPath) {
        return new FileRollbackOutcome(filePath, action, true, null, backupPath);
    }

    public static FileRollbackOutcome failed(String filePath, FileRollbackAction action, String message,
                                             String backupPath) {
        return new FileRollbackOutcome(filePath, action, false, message, backupPath);
    }
}

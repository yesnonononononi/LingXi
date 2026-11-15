package com.summit.dp.workflow.application.filerecord;

/** 单个文件在这次回滚里要做的动作。 */
public enum FileRollbackAction {

    /** 用基线原文覆盖回去。 */
    RESTORE,

    /** 该文件在执行期间才出现，回滚即删除。 */
    DELETE,

    /** 不动盘，原因在 {@code reason}。 */
    SKIP
}

package com.summit.dp.workflow.application.filerecord;

import java.util.List;

/**
 * 一次回滚的逐文件结果。
 *
 * <p>失败不聚成一个异常：回填没有事务，写了三个成功一个失败的事实必须如实交回给用户，
 * 而不是抛一句「回滚失败」让他自己去猜哪些文件动过。</p>
 *
 * @param executionId 执行标识
 * @param outcomes    逐文件结果
 */
public record FileRollbackResult(String executionId, List<FileRollbackOutcome> outcomes) {

    public FileRollbackResult {
        outcomes = List.copyOf(outcomes);
    }

    public long successCount() {
        return this.outcomes.stream().filter(FileRollbackOutcome::success).count();
    }

    public long failureCount() {
        return this.outcomes.size() - this.successCount();
    }
}

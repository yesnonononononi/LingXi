package com.summit.dp.task.domain.model;

import java.time.Instant;

/**
 * 后台任务列表用的只读摘要：除 {@code output} 外的全部展示列。
 *
 * <p><b>为什么不复用 {@link Task}</b>：列表从不展示 {@code output}，而它是最长的一个 CLOB。
 * 裁剪出来的模型是<b>不完整</b>的，一旦有人拿它去 {@code updateById}，输出列就会被静默清空 ——
 * 所以用独立的只读记录表达，类型上就不给它落库的机会。</p>
 */
public record TaskSummary(
        Long id,
        Long sessionId,
        Long turnId,
        String command,
        String intention,
        Task.TaskStatus status,
        Integer exitCode,
        boolean truncated,
        Instant createAt,
        Instant completeAt) {
}

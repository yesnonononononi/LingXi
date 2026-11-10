package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.Builder;

import java.io.Serializable;
import java.time.Instant;

/**
 * 一次文件修改的记录，<b>只存差异不存正文</b>。
 *
 * <p>投影口径（同一 {@code executionId + turnId + filePath} 的记录按写入顺序排列）：
 * <b>首条</b>携带 {@link #baseline}——本轮首次修改该文件之前的全文，也就是「基线」；
 * 其余记录的 {@code baseline} 为 {@code null}。每条都携带自己那一次的 unified diff 与增删行数。
 * 把 diff 依次重放回基线，就得到该文件在本轮结束时的内容。</p>
 *
 * <p><b>为什么不存 newContent</b>：一轮里改同一个文件十次就等于把全文存十份，
 * 长会话下这是纯浪费，也是此前 OOM 隐患的主因。差异本身已经足够重建与展示。</p>
 *
 * <p>{@code baseline} 为 {@code null} 只对首条有含义：表示本轮开始时该文件并不存在（新建文件）。
 * 非首条记录的 {@code baseline} 一律为 {@code null}，读的时候只能看首条。</p>
 */
@Builder
public record FileRecord(
        Serializable id,
        Serializable executionId,
        Serializable turnId,
        Integer version,
        String filePath,
        String baseline,
        String diff,
        int plusLines,
        int minusLines,
        Instant createAt
) {
}


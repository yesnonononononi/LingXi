package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.Builder;

import java.io.Serializable;
import java.time.Instant;

/**
 * 一次文件修改的记录，<b>只存差异不存正文</b>。
 *
 * <p>投影口径（同一 {@code executionId + turnId + filePath} 的记录按写入顺序排列）：
 * <b>分段起点</b>携带 {@link #baseline}——这一段开始时该文件的全文；同一段的后续记录
 * {@code baseline} 为 {@code null}。每条都携带自己那一次的 unified diff、增删行数与
 * {@link #contentDigest}（改完之后的全文摘要）。把 diff 依次重放回基线，就得到该文件在本轮结束时的内容。</p>
 *
 * <p><b>为什么要分段</b>：链只有在「改动都经过 {@code edit_file}」时才连续。用 shell / python
 * 直写、甚至删了重建，都不会留下记录，链就断在中间，后续 diff 的上下文对不上。
 * 登记时比对 {@link #contentDigest} 与下次编辑的「改之前摘要」，一比不一致就把这条当成新的
 * 分段起点、重新保留一份基线 —— 代价只是一段历史不连续，而不是整份差异都重建不出来。</p>
 *
 * <p><b>为什么不存 newContent</b>：一轮里改同一个文件十次就等于把全文存十份，
 * 长会话下这是纯浪费，也是此前 OOM 隐患的主因。差异本身已经足够重建与展示。</p>
 *
 * <p>{@code baseline} 为 {@code null} 且是分段起点时表示「这一段从空文件开始」：
 * 本轮新建文件，或者文件在工具之外被删掉后重新创建。读的时候只能看分段起点那一条。</p>
 *
 * <p>{@link #baselineMissing} 把「从空文件开始」和「基线丢了」分开：库里存了基线路径却读不回内容
 * （过期回收或文件被人删了）时必须为 {@code true}。两者都表现为 {@code baseline == null}，
 * 混为一谈就会把整份文件算成新增，界面上的行数全是假的。</p>
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
        Instant createAt,
        /** 基线引用过但内容已读不回来；{@code false} 且 {@code baseline == null} 表示这一段从空文件开始。 */
        boolean baselineMissing,
        /** 本次修改后的全文摘要；老记录（V16 之前）没有这个值，按「链不可验证」处理。 */
        String contentDigest,
        /** 本条是否是新分段的起点（携带基线的那条）；老记录靠「有没有基线」等价判断。 */
        boolean segmentStart
) {
}


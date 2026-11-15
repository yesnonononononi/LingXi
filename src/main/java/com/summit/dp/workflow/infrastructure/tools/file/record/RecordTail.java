package com.summit.dp.workflow.infrastructure.tools.file.record;

import java.io.Serializable;
import java.time.Instant;

/**
 * 本轮该文件最后一条记录的位置、末态摘要与回滚标记，供登记与回滚判定使用。
 *
 * <p>只带这三列是刻意的：登记每次编辑都要问一次，读成完整记录意味着把基线与 diff 也读回来。</p>
 *
 * @param id            记录标识，链断时用来在日志里指出断点
 * @param contentDigest 该记录修改后的内容摘要；老记录没有这个值（{@code null}）
 * @param rolledBackAt  末条记录被按基线回填的时间；{@code null} 表示没回滚过
 */
public record RecordTail(Serializable id, String contentDigest, Instant rolledBackAt) {
}

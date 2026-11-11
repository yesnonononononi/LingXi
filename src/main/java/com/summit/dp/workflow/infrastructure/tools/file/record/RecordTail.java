package com.summit.dp.workflow.infrastructure.tools.file.record;

import java.io.Serializable;

/**
 * 本轮该文件最后一条记录的位置与末态摘要，供登记时判断链是否还连着。
 *
 * <p>只带这两列是刻意的：登记每次编辑都要问一次，读成完整记录意味着把基线与 diff 也读回来。</p>
 *
 * @param id            记录标识，链断时用来在日志里指出断点
 * @param contentDigest 该记录修改后的内容摘要；老记录没有这个值（{@code null}）
 */
public record RecordTail(Serializable id, String contentDigest) {
}

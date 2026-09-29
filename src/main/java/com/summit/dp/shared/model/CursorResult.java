package com.summit.dp.shared.model;

import java.util.List;

/**
 * 统一的游标分页载体（替代旧的 {@code MessageSlice}）。
 *
 * <p>字段语义与原 {@code MessageSlice} 完全等价，供 session 领域与应用层共用：
 * {@code records} 为已按「旧 → 新」排序的一页记录，{@code nextCursor} 为下一页游标
 * （为空表示已到末页），{@code hasMore} 表示是否还有更早的一页。</p>
 *
 * @param <T> 记录类型
 */
public record CursorResult<T>(List<T> records, String nextCursor, boolean hasMore) {

    /** 空页：无记录、无游标、无更多。 */
    public static <T> CursorResult<T> empty() {
        return new CursorResult<>(List.of(), null, false);
    }
}

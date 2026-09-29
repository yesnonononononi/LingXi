package com.summit.dp.mcp.domain.event;

import lombok.Data;
import lombok.NonNull;

import java.util.Collection;

/**
 * Mcp 批量查询事件（生成骨架）
 * <p>调用方携带标识集合发布，由接口层的批量查询响应器监听后批量返回视图对象。</p>
 */
@Data
public class McpBatchQueryEvent {
    @NonNull
    private Collection<Long> ids;
}

package com.summit.dp.mcp.api.feign;

import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.mcp.application.vo.McpVO;
import com.summit.dp.mcp.domain.event.McpBatchQueryEvent;
import lombok.RequiredArgsConstructor;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;

/**
 * Mcp 批量查询事件响应器（生成骨架）
 * <p>监听 {@code McpBatchQueryEvent}，按标识集合一次性返回视图对象，避免调用方逐条查询。</p>
 */
@Component
@RequiredArgsConstructor
public class McpFeign {
    private final McpService service;

    @EventListener(value = McpBatchQueryEvent.class)
    public List<McpVO> queryIn(McpBatchQueryEvent event) {
        Collection<Long> ids = event.getIds();
        if (ids.isEmpty())
            return List.of();
        return service.queryIn(ids).getData();
    }
}

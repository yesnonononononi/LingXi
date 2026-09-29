package com.summit.dp.agent.api.feign;

import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.domain.event.AgentBatchQueryEvent;
import lombok.RequiredArgsConstructor;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;

/** Agent 批量查询事件响应器（生成骨架） */
@Component
@RequiredArgsConstructor
public class AgentFeign {
    private final AgentService service;

    @EventListener(value = AgentBatchQueryEvent.class)
    public List<AgentVO> queryIn(AgentBatchQueryEvent event) {
        Collection<Long> ids = event.getIds();
        if (ids.isEmpty())
            return List.of();
        return service.queryIn(ids).getData();
    }
}

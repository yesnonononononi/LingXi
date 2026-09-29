package com.summit.dp.team.api.feign;

import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.team.domain.event.TeamBatchQueryEvent;
import lombok.RequiredArgsConstructor;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;

/** Team 批量查询事件响应器（生成骨架） */
@Component
@RequiredArgsConstructor
public class TeamFeign {
    private final TeamService service;

    @EventListener(value = TeamBatchQueryEvent.class)
    public List<TeamVO> queryIn(TeamBatchQueryEvent event) {
        Collection<Long> ids = event.getIds();
        if (ids.isEmpty())
            return List.of();
        return service.queryIn(ids).getData();
    }
}

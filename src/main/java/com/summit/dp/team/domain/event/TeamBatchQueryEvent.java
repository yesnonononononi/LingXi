package com.summit.dp.team.domain.event;

import lombok.Data;
import lombok.NonNull;

import java.util.Collection;

/** Team 批量查询事件（生成骨架） */
@Data
public class TeamBatchQueryEvent {
    @NonNull
    private Collection<Long> ids;
}

package com.summit.dp.agent.domain.event;

import lombok.Data;
import lombok.NonNull;

import java.util.Collection;

/** Agent 批量查询事件（生成骨架） */
@Data
public class AgentBatchQueryEvent {
    @NonNull
    private Collection<Long> ids;
}

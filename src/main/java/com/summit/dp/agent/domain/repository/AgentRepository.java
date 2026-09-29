package com.summit.dp.agent.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.agent.domain.model.Agent;

import java.util.Collection;

/** Agent 领域仓储（生成骨架） */
public interface AgentRepository extends RepositoryTemplate<Agent, Long> {

    /** 按标识集合批量查询（生成骨架，供应用层 queryIn 使用） */
    Collection<Agent> findList(Collection<Long> ids);
}

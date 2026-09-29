package com.summit.dp.team.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.team.domain.model.Team;

import java.util.Collection;

/** Team 领域仓储（生成骨架） */
public interface TeamRepository extends RepositoryTemplate<Team, Long> {

    /** 按标识集合批量查询（生成骨架，供应用层 queryIn 使用） */
    Collection<Team> findList(Collection<Long> ids);
}

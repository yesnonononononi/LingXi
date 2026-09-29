package com.summit.dp.team.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.team.application.command.TeamCommand;
import com.summit.dp.team.application.vo.TeamVO;

import java.util.Collection;
import java.util.List;

/** Team 应用层服务接口（生成骨架） */
public interface TeamService {
    Result<TeamVO> findById(Long id);

    Result<PageResult<TeamVO>> findPage(Integer page, Integer pageSize);

    Result<Void> add(TeamCommand command);

    Result<Void> update(TeamCommand command);

    Result<Void> delById(Long id);

    Result<List<TeamVO>> queryIn(Collection<Long> ids);
}

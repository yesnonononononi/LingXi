package com.summit.dp.team.application.service.impl;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.command.TeamCommand;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.team.domain.model.Team;
import com.summit.dp.team.domain.repository.TeamRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/** Team 应用层服务实现 */
@Service
@RequiredArgsConstructor
@Slf4j
public class TeamServiceImpl implements TeamService {

    private final TeamRepository repository;
    private final TeamValidator validator;
    private final AgentService agentService;

    @Override
    public Result<TeamVO> findById(Long id) {
        if (id == null)
            throw new ClientException("id is null");
        Team model = repository.findById(id)
                .orElseThrow(() -> new ClientException("id 对应数据不存在: " + id));
        return Result.success(toVO(model, agentMapOf(List.of(model))));
    }

    @Override
    public Result<PageResult<TeamVO>> findPage(Integer page, Integer pageSize) {
        int current = page == null ? 1 : Math.max(page, 1);
        int size = pageSize == null ? 10 : Math.max(pageSize, 1);
        IPage<Team> pageResult = repository.queryByPage(current, size);
        List<Team> records = pageResult.getRecords();
        Map<Long, AgentVO> agentMap = agentMapOf(records);
        PageResult<TeamVO> result = new PageResult<>(pageResult.getCurrent(), pageResult.getSize(),
                pageResult.getTotal(), records.stream().map(team -> toVO(team, agentMap)).toList());
        return Result.success(result);
    }

    @Override
    public Result<Void> add(TeamCommand command) {
        String error = validator.validateForCreate(command);
        if (error != null) throw new ClientException(error);
        repository.save(toModel(command));
        return Result.success();
    }

    @Override
    public Result<Void> update(TeamCommand command) {
        String error = validator.validateForUpdate(command);

        if (error != null) throw new ClientException(error);

        Team model = repository.findById(command.getId())
                .orElseThrow(() -> new ClientException("id 对应数据不存在: " + command.getId()));

        model = update(command, model);

        repository.updateById(model);
        return Result.success();
    }

    @Override
    public Result<Void> delById(Long id) {
        if (id == null)
            throw new ClientException("id is null");
        repository.findById(id).ifPresent(repository::delete);
        return Result.success();
    }

    @Override
    public Result<List<TeamVO>> queryIn(Collection<Long> ids) {
        if (ids == null || ids.isEmpty())
            return Result.success(List.of());
        List<Team> teams = repository.findList(ids).stream().toList();
        Map<Long, AgentVO> agentMap = agentMapOf(teams);
        return Result.success(teams.stream().map(team -> toVO(team, agentMap)).toList());
    }


    public Team update(TeamCommand command,Team team){
        if(command.getAgentIds() != null && !command.getAgentIds().isEmpty()) team.changeAgentIds(command.getAgentIds());
        if(command.getCommanderAgentId() != null) team.changeCommanderAgentId(command.getCommanderAgentId());
        if(command.getName() != null) team.changeName(command.getName());
        if(command.getDescription() != null) team.changeDescription(command.getDescription());
        return team;
    }





    /** 一次性批量拉取涉及的 Agent，避免按团队逐个查询 */
    private Map<Long, AgentVO> agentMapOf(Collection<Team> teams) {
        List<Long> ids = teams.stream()
                .filter(Objects::nonNull)
                .flatMap(team -> team.getAgentIds() == null ? Stream.empty() : team.getAgentIds().stream())
                .filter(Objects::nonNull)
                .distinct()
                .toList();
        if (ids.isEmpty()) return Map.of();
        List<AgentVO> agents = agentService.queryIn(ids).getData();
        if (agents == null) return Map.of();
        return agents.stream()
                .filter(agent -> agent != null && agent.getId() != null)
                .collect(Collectors.toMap(AgentVO::getId, Function.identity(), (a, b) -> a));
    }

    private TeamVO toVO(Team model, Map<Long, AgentVO> agentMap) {
        return TeamVO.builder()
                .id(model.getId())
                .name(model.getName())
                .commanderName(model.getCommanderAgentId() == null ? null : agentMap.get(model.getCommanderAgentId()) == null ? null : agentMap.get(model.getCommanderAgentId()).getName())
                .commanderAgentId(model.getCommanderAgentId())
                .agents(model.getAgentIds() == null ? List.of() : model.getAgentIds().stream()
                        .map(agentMap::get)
                        .filter(Objects::nonNull)
                        .toList())
                .description(model.getDescription())
                .build();
    }

    private Team toModel(TeamCommand command) {
         return Team.builder()
                .id(command.getId())
                .name(command.getName())
                 .description(command.getDescription())
                .commanderAgentId(command.getCommanderAgentId())
                .agentIds(command.getAgentIds())
                .build();
    }
}

package com.summit.dp.team.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.team.domain.model.Team;
import com.summit.dp.team.domain.repository.TeamRepository;
import com.summit.dp.team.infrastructure.persistence.mapper.TeamMapper;
import com.summit.dp.team.infrastructure.persistence.po.TeamPO;
import org.jetbrains.annotations.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Objects;

/** Team 仓储实现 */
@Repository
public class TeamRepositoryImpl extends AbstractRepository<Team, TeamPO, Long>
        implements TeamRepository {

    private static final String SEPARATOR = ",";

    private final TeamMapper mapper;

    public TeamRepositoryImpl(TeamMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<TeamPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Team> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    protected Team toModel(TeamPO po) {
        return Team.builder()
                .id(po.getId())
                .name(po.getName())
                .commanderAgentId(po.getCommanderAgentId())
                .agentIds(parseAgentIds(po.getAgentIds()))
                .description(po.getDescription())
                .createAt(po.getCreateTime())
                .updateAt(po.getUpdateTime())
                .build();
    }

    @Override
    protected TeamPO toPO(Team model) {
        return TeamPO.builder()
                .id(model.getId())
                .name(model.getName())
                .commanderAgentId(model.getCommanderAgentId())
                .agentIds(writeAgentIds(model.getAgentIds()))
                .description(model.getDescription())
                .createTime(model.getCreateAt())
                .updateTime(model.getUpdateAt())
                .build();
    }

    private List<Long> parseAgentIds(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        return Arrays.stream(raw.split(SEPARATOR))
                .map(String::trim)
                .filter(id -> !id.isEmpty())
                .map(Long::valueOf)
                .toList();
    }

    private String writeAgentIds(List<Long> agentIds) {
        if (agentIds == null || agentIds.isEmpty()) return null;
        return agentIds.stream()
                .filter(Objects::nonNull)
                .map(String::valueOf)
                .reduce((a, b) -> a + SEPARATOR + b)
                .orElse(null);
    }
}

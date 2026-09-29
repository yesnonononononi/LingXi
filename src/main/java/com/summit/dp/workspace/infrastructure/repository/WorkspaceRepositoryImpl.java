package com.summit.dp.workspace.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.dp.workspace.infrastructure.persistence.mapper.WorkspaceMapper;
import com.summit.dp.workspace.infrastructure.persistence.po.WorkspacePO;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** 工作空间仓储实现：业务实体（枚举判别）与 PO（字符串落库）的双向映射 + MyBatis-Plus 读写。 */
@Repository
public class WorkspaceRepositoryImpl extends AbstractRepository<Workspace, WorkspacePO, Long>
        implements WorkspaceRepository {

    private final WorkspaceMapper mapper;

    public WorkspaceRepositoryImpl(WorkspaceMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<WorkspacePO> mapper() {
        return this.mapper;
    }

    @Override
    public Long saveAndReturnId(Workspace entity) {
        Number id = save(entity, WorkspacePO::getId);
        return id == null ? null : id.longValue();
    }

    @Override
    public List<Workspace> findByIds(Collection<Long> ids) {
        Collection<Workspace> models = findList(ids);
        return models instanceof List<Workspace> list ? list : new ArrayList<>(models);
    }

    @Override
    public Workspace findByHostDir(String hostDir) {
        List<WorkspacePO> list = mapper.selectList(new QueryWrapper<WorkspacePO>()
                .eq("host_dir", hostDir)
                .orderByDesc("id"));
        return list.isEmpty() ? null : toModel(list.get(0));
    }

    @Override
    public List<Workspace> findAll() {
        return mapper.selectList(new QueryWrapper<>()).stream().map(this::toModel).toList();
    }

    @Override
    public IPage<Workspace> queryByPage(int current, int size) {
        return queryByPage(current, size, new QueryWrapper<WorkspacePO>().orderByDesc("id"));
    }

    @Override
    protected Workspace toModel(WorkspacePO po) {
        return new Workspace(
                po.getId(),
                po.getName(),
                po.getHostDir());
    }

    @Override
    protected WorkspacePO toPO(Workspace model) {
        return WorkspacePO.builder()
                .id(model.getId())
                .name(model.getName())
                .hostDir(model.getHostDir())
                .build();
    }
}

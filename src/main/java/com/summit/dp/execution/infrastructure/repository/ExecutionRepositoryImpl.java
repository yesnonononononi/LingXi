package com.summit.dp.execution.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import org.jetbrains.annotations.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.shared.exception.ClientException;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * Execution 仓储实现（生成骨架）
 */
@Repository
public class ExecutionRepositoryImpl extends AbstractRepository<Execution, ExecutionPO, Long>
        implements ExecutionRepository {

    private final ExecutionMapper mapper;

    public ExecutionRepositoryImpl(ExecutionMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<ExecutionPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Execution> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override public void save(Execution model) {
        super.save(model);
    }
    @Override public void updateById(Execution model) {
        long version = model.getVersion();
        ExecutionPO row = toPO(model);
        row.setVersion(version + 1);
        if (mapper.update(row, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, model.getId())
                .eq(ExecutionPO::getVersion, version)) != 1) throw new ClientException("执行状态已变更，请刷新后重试");
        model.acceptPersistedVersion(version + 1);
    }
    @Override public void update(Collection<Execution> models) { models.forEach(this::updateById); }


    @Override
    public List<Execution> findRecentBySession(Long sessionId, int limit) {
        return mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                        .eq(ExecutionPO::getSessionId, sessionId)
                        .orderByDesc(ExecutionPO::getId)
                        .last("LIMIT " + Math.clamp(limit, 1, 100)))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<Execution> findUnfinishedBySessions(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return List.of();
        return mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                .select(ExecutionPO::getId, ExecutionPO::getSessionId, ExecutionPO::getStatus,
                        ExecutionPO::getVersion, ExecutionPO::getStartedAt, ExecutionPO::getCompletedAt)
                .in(ExecutionPO::getSessionId, sessionIds)
                .in(ExecutionPO::getStatus,
                        ExecutionStatusCodes.CREATED, ExecutionStatusCodes.RUNNING, ExecutionStatusCodes.SUSPENDED))
                .stream().map(this::toModel).toList();
    }

    /** 只取 session_id 一列：归属判定不该为了一个外键把 LONGTEXT 检查点读进内存。 */
    @Override
    public Optional<Long> findSessionId(long executionId) {
        ExecutionPO row = mapper.selectOne(new LambdaQueryWrapper<ExecutionPO>()
                .select(ExecutionPO::getSessionId)
                .eq(ExecutionPO::getId, executionId));
        return row == null ? Optional.empty() : Optional.ofNullable(row.getSessionId());
    }

    @Override
    public Optional<Long> findLatestSuspendedId(long sessionId) {
        ExecutionPO row = mapper.selectOne(new LambdaQueryWrapper<ExecutionPO>()
                .select(ExecutionPO::getId)
                .eq(ExecutionPO::getSessionId, sessionId)
                .eq(ExecutionPO::getStatus, ExecutionStatusCodes.SUSPENDED)
                .orderByDesc(ExecutionPO::getId)
                .last("LIMIT 1"));
        return row == null ? Optional.empty() : Optional.ofNullable(row.getId());
    }

    @Override
    public int markOrphanRunsFailed() {
        return mapper.markOrphanRunsFailed(ExecutionStatusCodes.FAILED,
                ExecutionStatusCodes.CREATED, ExecutionStatusCodes.RUNNING);
    }

    @Override
    public List<Execution> findLatestBySessionAndStatus(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return List.of();
        return mapper.selectLatestBySessionAndStatus(sessionIds).stream().map(this::toModel).toList();
    }

    /**
     * 查询摘要投影：显式列出需要的列，**排除 snapshot**。
     *
     * <p>用 LambdaQueryWrapper 的 select 而不是自定义 SQL —— MyBatis-Plus 会按
     * {@code @TableField} 生成实体 resultMap，列名映射因此不依赖全局驼峰开关。</p>
     *
     * <p>投影里只有框架自己的运行记录（状态 / 起止时间）；模型与 token
     * 是业务事实，已不在本表，展示侧一律去 {@code chat_turn} 取。</p>
     */
    @Override
    public List<Execution> findSummariesByIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) return List.of();
        return mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                        .select(ExecutionPO::getId, ExecutionPO::getSessionId, ExecutionPO::getStatus,
                                ExecutionPO::getVersion,
                                ExecutionPO::getResumeGeneration,
                                ExecutionPO::getStartedAt, ExecutionPO::getCompletedAt)
                        .in(ExecutionPO::getId, executionIds))
                .stream().map(this::toModel).toList();
    }

    @Override
    public long findResumeGeneration(long executionId) {
        ExecutionPO row = mapper.selectOne(new LambdaQueryWrapper<ExecutionPO>()
                .select(ExecutionPO::getResumeGeneration)
                .eq(ExecutionPO::getId, executionId));
        return row == null || row.getResumeGeneration() == null ? 0L : row.getResumeGeneration();
    }

    @Override
    protected Execution toModel(ExecutionPO po) {
        Execution model = new Execution();
        BeanUtils.copyProperties(po, model);
        if (po.getVersion() == null) model.acceptPersistedVersion(1L);
        return model;
    }

    @Override
    protected ExecutionPO toPO(Execution model) {
        ExecutionPO po = new ExecutionPO();
        BeanUtils.copyProperties(model, po);
        return po;
    }
}

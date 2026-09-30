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

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.List;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;

/**
 * Execution 仓储实现（生成骨架）
 */
@Repository
public class ExecutionRepositoryImpl extends AbstractRepository<Execution, ExecutionPO, Long>
        implements ExecutionRepository {

    /** execution.status 终态/过程态常量，与框架 {@code ExecutionState} 序号一一对应。 */
    private static final int STATUS_CREATED = 0;
    private static final int STATUS_RUNNING = 1;
    private static final int STATUS_FAILED = 4;

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


    @Override
    public List<Execution> findRecentBySession(Long sessionId, int limit) {
        return mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                        .eq(ExecutionPO::getSessionId, sessionId)
                        .orderByDesc(ExecutionPO::getId)
                        .last("LIMIT " + Math.max(1, Math.min(limit, 100))))
                .stream().map(this::toModel).toList();
    }

    @Override
    public int markOrphanRunsFailed() {
        return mapper.markOrphanRunsFailed(STATUS_FAILED, STATUS_CREATED, STATUS_RUNNING);
    }

    @Override
    public int markFailedIfUnfinished(long executionId, LocalDateTime completedAt) {
        return mapper.markFailedIfUnfinished(executionId, STATUS_FAILED,
                STATUS_CREATED, STATUS_RUNNING, completedAt);
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
     */
    @Override
    public List<Execution> findSummariesByIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) return List.of();
        return mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                        .select(ExecutionPO::getId, ExecutionPO::getSessionId, ExecutionPO::getStatus,
                                ExecutionPO::getRootExecutionId, ExecutionPO::getModelName,
                                ExecutionPO::getModelProvider, ExecutionPO::getInputTokenCount,
                                ExecutionPO::getOutputTokenCount, ExecutionPO::getTotalTokenCount,
                                ExecutionPO::getStartedAt, ExecutionPO::getCompletedAt)
                        .in(ExecutionPO::getId, executionIds))
                .stream().map(this::toModel).toList();
    }

    @Override
    protected Execution toModel(ExecutionPO po) {
        Execution model = new Execution();
        BeanUtils.copyProperties(po, model);
        return model;
    }

    @Override
    protected ExecutionPO toPO(Execution model) {
        ExecutionPO po = new ExecutionPO();
        BeanUtils.copyProperties(model, po);
        return po;
    }
}

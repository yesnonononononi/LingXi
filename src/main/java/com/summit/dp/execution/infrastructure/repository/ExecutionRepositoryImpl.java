package com.summit.dp.execution.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.*;

/**
 * Execution 仓储实现（生成骨架）
 */
@Repository
public class ExecutionRepositoryImpl extends AbstractRepository<Execution, ExecutionPO, Long>
        implements ExecutionRepository {

    /** 待收口位的「待办」取值：与 V5 迁移里的列语义一致（1 待收口 / 0 已收口）。 */
    private static final int CLOSURE_PENDING = 1;
    /** 单批扫描上限：启动补偿只处理有界的一批，避免拉全表。 */
    private static final int MAX_CLOSURE_BATCH = 1000;

    private final ExecutionMapper mapper;

    public ExecutionRepositoryImpl(ExecutionMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected BaseMapper<ExecutionPO> mapper() {
        return this.mapper;
    }

    @Override
    public long countReclaimable() {
        return mapper.countReclaimable();
    }

    @Override
    public List<Execution> findReclaimable(long afterId, int limit) {
        return mapper.findReclaimable(afterId, Math.clamp(limit, 1, 500)).stream().map(this::toModel).toList();
    }

    @Override
    public boolean deleteReclaimable(long executionId, long version) {
        return mapper.deleteReclaimable(executionId, version) == 1;
    }

    @Override
    public List<Long> findIdsBySessions(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return List.of();
        }
        return mapper.selectIdsBySessionIds(sessionIds);
    }

    @Override
    public int deleteBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return 0;
        }
        return mapper.delete(Wrappers.<ExecutionPO>lambdaQuery().in(ExecutionPO::getSessionId, sessionIds));
    }

    @Override
    public Collection<Execution> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public Optional<Execution> findCheckpointSummary(long executionId) {
        return Optional.ofNullable(mapper.selectOne(Wrappers.<ExecutionPO>lambdaQuery()
                .select(ExecutionPO::getId, ExecutionPO::getSessionId, ExecutionPO::getStatus, ExecutionPO::getVersion,
                        ExecutionPO::getResumeGeneration, ExecutionPO::getSnapshotFile,
                        ExecutionPO::getClosurePending)
                .eq(ExecutionPO::getId, executionId)))
                .map(row -> Execution.restoreCheckpointSummary(row.getId(), row.getVersion(),
                        row.getStatus(), row.getResumeGeneration(), row.getSessionId(), row.getSnapshotFile(),
                        row.getClosurePending()));
    }

    @Override
    public List<Long> findClosurePendingIds(int limit) {
        return mapper.findClosurePendingIds(CLOSURE_PENDING, Math.clamp(limit, 1, MAX_CLOSURE_BATCH));
    }

    @Override
    public List<Long> findClosurePendingIdsAfter(long afterId, int limit) {
        return mapper.findClosurePendingIdsAfter(CLOSURE_PENDING, afterId,
                Math.clamp(limit, 1, MAX_CLOSURE_BATCH));
    }

    /**
     * 按 id 条件清理待收口事实，只命中仍为 1 的行。
     *
     * <p><b>为什么不用 {@code updateById}</b>：那条路径带版本条件并会推进版本号，
     * 而这里要改的是一个与业务版本无关的待办位；按 id + 当前值条件更新既够用，
     * 也把「漏清」变成可观测的返回值（0 行 = 别人已经清过或从没置过）。</p>
     *
     * @return 是否真的把 1 改成了 0
     */
    @Override
    public boolean isClosurePending(long executionId) {
        return Integer.valueOf(CLOSURE_PENDING).equals(mapper.selectClosurePending(executionId));
    }

    @Override
    public boolean clearClosurePending(long executionId) {
        return mapper.update(null, Wrappers.<ExecutionPO>lambdaUpdate()
                .set(ExecutionPO::getClosurePending, 0)
                .eq(ExecutionPO::getId, executionId)
                .eq(ExecutionPO::getClosurePending, CLOSURE_PENDING)) == 1;
    }

    @Override public void save(Execution model) {
        super.save(model);
    }
    @Override public void updateById(Execution model) {
        long version = model.getVersion();
        ExecutionPO row = toPO(model);
        // 归属只供状态通知读取，更新检查点不能重写创建时的归属。
        row.setSessionId(null);
        row.setVersion(version + 1);
        if (mapper.update(row, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, model.getId())
                .eq(ExecutionPO::getVersion, version)) != 1) throw new ClientException("执行状态已变更，请刷新后重试");
        model.acceptPersistedVersion(version + 1);
    }
    @Override public void update(Collection<Execution> models) { models.forEach(this::updateById); }


    @Override
    public List<Execution> findRecentBySession(Long sessionId, int limit) {
        return mapper.findRecentBySession(sessionId, Math.clamp(limit, 1, 100)).stream().map(this::toModel).toList();
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

    /** 只取 session_id 一列：归属判定不该为了一个外键把检查点正文读进内存。 */
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

    /** 启动自检的「仍活跃」候选：一次单表查询取去重会话 id，不读检查点正文。 */
    @Override
    public List<Long> findUnfinishedSessionIds() {
        return mapper.selectUnfinishedSessionIds(
                List.of(ExecutionStatusCodes.CREATED, ExecutionStatusCodes.RUNNING, ExecutionStatusCodes.SUSPENDED));
    }

    @Override
    public List<Execution> findLatestBySessionAndStatus(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return List.of();
        return mapper.selectLatestBySessionAndStatus(sessionIds).stream().map(this::toModel).toList();
    }

    /**
     * 查询摘要投影：显式列出需要的列，**排除 snapshot_file**（正文本来就不在库里）。
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

    /** 批量取「执行 id → 检查点文件标识」，只读两列，供检查点文件回收判引用。 */
    @Override
    public Map<Long, String> findSnapshotFileIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, String> referenced = new LinkedHashMap<>();
        for (ExecutionPO row : mapper.selectList(new LambdaQueryWrapper<ExecutionPO>()
                .select(ExecutionPO::getId, ExecutionPO::getSnapshotFile)
                .in(ExecutionPO::getId, executionIds))) {
            if (row.getId() != null && row.getSnapshotFile() != null) {
                referenced.put(row.getId(), row.getSnapshotFile());
            }
        }
        return referenced;
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

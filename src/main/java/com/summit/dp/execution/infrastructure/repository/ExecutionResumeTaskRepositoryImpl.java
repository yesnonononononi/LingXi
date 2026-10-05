package com.summit.dp.execution.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

/**
 * 恢复意图仓储实现。
 *
 * <p><b>为什么不用 AbstractRepository 的整行 updateById</b>：恢复任务的状态被决策、取消、
 * stop、另一 worker 同时读写，整行覆盖会让「stop 已经把执行标成 CANCELLED」被一条迟到的
 * 恢复状态改回去 —— 这正是方案里点名的 stale 检查点事故。本仓储的每次状态写入都带
 * {@code eq(id).eq(version).eq(state)} 三重条件，命中 0 行即让位。</p>
 */
@Repository
@RequiredArgsConstructor
public class ExecutionResumeTaskRepositoryImpl
        extends AbstractRepository<ExecutionResumeTask, ExecutionResumeTaskPO, Long>
        implements ExecutionResumeTaskRepository {

    private final ExecutionResumeTaskMapper taskMapper;

    @Override
    public Optional<ExecutionResumeTask> findById(Long id) {
        if (id == null) return Optional.empty();
        ExecutionResumeTaskPO row = taskMapper.selectById(id);
        return row == null ? Optional.empty() : Optional.of(toModel(row));
    }

    @Override
    public Optional<ExecutionResumeTask> findByExecutionAndGeneration(long executionId, long generation) {
        ExecutionResumeTaskPO row = taskMapper.selectOne(Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                .eq(ExecutionResumeTaskPO::getExecutionId, executionId)
                .eq(ExecutionResumeTaskPO::getGeneration, generation));
        return row == null ? Optional.empty() : Optional.of(toModel(row));
    }

    @Override
    public List<ExecutionResumeTask> findByExecutionId(long executionId) {
        return taskMapper.selectList(Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                        .eq(ExecutionResumeTaskPO::getExecutionId, executionId)
                        .orderByAsc(ExecutionResumeTaskPO::getGeneration))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<ExecutionResumeTask> listDispatchable(Instant now, int limit) {
        LocalDateTime deadline = toLocalDateTime(now);
        // 退避条件是「可立即派发」：next_attempt_at 为空，或已到点。
        // 写成 .and(...) 内嵌，.last() 必须挂在最外层 wrapper 上，挂在内层会拼不出合法 SQL。
        LambdaQueryWrapper<ExecutionResumeTaskPO> wrapper = Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                .in(ExecutionResumeTaskPO::getState,
                        ResumeTaskState.READY.dbValue(), ResumeTaskState.FAILED.dbValue())
                .and(nested -> nested.isNull(ExecutionResumeTaskPO::getNextAttemptAt)
                        .or().le(ExecutionResumeTaskPO::getNextAttemptAt, deadline))
                .orderByAsc(ExecutionResumeTaskPO::getId)
                .last("LIMIT " + Math.clamp(limit, 1, 200));
        return taskMapper.selectList(wrapper).stream().map(this::toModel).toList();
    }

    @Override
    public List<ExecutionResumeTask> listClaimed(int limit) {
        // 只按状态等值查询：遗留 CLAIMED 的处置由启动分流按执行状态与代际逐个判定，不做退避过滤。
        LambdaQueryWrapper<ExecutionResumeTaskPO> wrapper = Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                .eq(ExecutionResumeTaskPO::getState, ResumeTaskState.CLAIMED.dbValue())
                .orderByAsc(ExecutionResumeTaskPO::getId)
                .last("LIMIT " + Math.clamp(limit, 1, 1000));
        return taskMapper.selectList(wrapper).stream().map(this::toModel).toList();
    }

    @Override
    public List<ExecutionResumeTask> listLiveByExecution(long executionId) {
        return taskMapper.selectList(Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                        .eq(ExecutionResumeTaskPO::getExecutionId, executionId)
                        .notIn(ExecutionResumeTaskPO::getState,
                                ResumeTaskState.SUCCEEDED.dbValue(), ResumeTaskState.SUPERSEDED.dbValue()))
                .stream().map(this::toModel).toList();
    }

    @Override
    public boolean claim(ExecutionResumeTask task, Instant now) {
        if (task == null || task.getId() == null) return false;
        // 状态条件也进 SQL：CL 要求「此刻仍是 READY 或已到点的 FAILED」，
        // 只靠内存里的旧值判定会在两 worker 并发领取时双双成功。
        int changed = taskMapper.update(Wrappers.<ExecutionResumeTaskPO>lambdaUpdate()
                .set(ExecutionResumeTaskPO::getState, ResumeTaskState.CLAIMED.dbValue())
                .set(ExecutionResumeTaskPO::getAttempts, task.getAttempts() + 1)
                .set(ExecutionResumeTaskPO::getErrorReason, null)
                .set(ExecutionResumeTaskPO::getNextAttemptAt, null)
                .set(ExecutionResumeTaskPO::getVersion, task.getVersion() + 1)
                // 领取时刻由 SQL 侧取：此刻领域对象还没执行 claim()，读它的 updatedAt 会拿到旧值。
                .set(ExecutionResumeTaskPO::getUpdatedAt, LocalDateTime.now())
                .eq(ExecutionResumeTaskPO::getId, task.getId())
                .eq(ExecutionResumeTaskPO::getVersion, task.getVersion())
                .in(ExecutionResumeTaskPO::getState,
                        ResumeTaskState.READY.dbValue(), ResumeTaskState.FAILED.dbValue())
                .and(wrapper -> wrapper.isNull(ExecutionResumeTaskPO::getNextAttemptAt)
                        .or().le(ExecutionResumeTaskPO::getNextAttemptAt, toLocalDateTime(now))));
        if (changed != 1) return false;
        task.claim();
        task.acceptPersistedVersion(task.getVersion() + 1);
        return true;
    }

    @Override
    public boolean updateState(ExecutionResumeTask task) {
        if (task == null || task.getId() == null) return false;
        long expected = task.getVersion();
        int changed = taskMapper.update(Wrappers.<ExecutionResumeTaskPO>lambdaUpdate()
                .set(ExecutionResumeTaskPO::getState, task.getState().dbValue())
                .set(ExecutionResumeTaskPO::getErrorReason, task.getErrorReason())
                .set(ExecutionResumeTaskPO::getNextAttemptAt, toLocalDateTime(task.getNextAttemptAt()))
                .set(ExecutionResumeTaskPO::getVersion, expected + 1)
                // 必须显式写 updated_at：终态回收窗口按它判断，而 MySQL 的 ON UPDATE CURRENT_TIMESTAMP
                // 在 H2(MODE=MySQL) 上不生效 —— 不写就等于按创建时刻回收，重试多轮的任务刚结束就会被清掉。
                .set(ExecutionResumeTaskPO::getUpdatedAt, LocalDateTime.now())
                .eq(ExecutionResumeTaskPO::getId, task.getId())
                .eq(ExecutionResumeTaskPO::getVersion, expected));
        if (changed != 1) return false;
        task.acceptPersistedVersion(expected + 1);
        return true;
    }

    /**
     * 受理恢复意图。
     *
     * <p>同执行同代际只允许一条：先查已有行，命中就复用（不新建、不重置 attempts）——
     * 「重复落定同一张卡片」和「审批重试」都会走到这里，重建一条新任务会让两次派发互相作废。</p>
     */
    @Override
    public ExecutionResumeTask enqueue(long executionId, long generation, Instant now) {
        Optional<ExecutionResumeTask> existing = findByExecutionAndGeneration(executionId, generation);
        if (existing.isPresent()) {
            return existing.get();
        }
        ExecutionResumeTaskPO row = new ExecutionResumeTaskPO();
        row.setExecutionId(executionId);
        row.setGeneration(generation);
        row.setState(ResumeTaskState.READY.dbValue());
        row.setAttempts(0);
        row.setVersion(1L);
        row.setCreatedAt(toLocalDateTime(now));
        row.setUpdatedAt(toLocalDateTime(now));
        if (taskMapper.insert(row) != 1) {
            // 唯一键冲突说明并发下另一路已插入：改读既有行，不把幂等冲突报成业务失败。
            return findByExecutionAndGeneration(executionId, generation).orElseThrow(
                    () -> new IllegalStateException("恢复任务受理失败: executionId=" + executionId
                            + ", generation=" + generation));
        }
        return toModel(row);
    }

    @Override
    public int purgeFinishedBefore(Instant cutoff) {
        return taskMapper.delete(Wrappers.<ExecutionResumeTaskPO>lambdaQuery()
                .in(ExecutionResumeTaskPO::getState,
                        ResumeTaskState.SUCCEEDED.dbValue(), ResumeTaskState.SUPERSEDED.dbValue())
                .lt(ExecutionResumeTaskPO::getUpdatedAt, toLocalDateTime(cutoff)));
    }

    @Override
    public void updateById(@NotNull ExecutionResumeTask model) {
        // 刻意不走整行覆盖：状态写入必须带 version 条件，见类注释。
        if (!updateState(model)) {
            throw new IllegalStateException("恢复任务状态已变化，请重新读取: taskId=" + model.getId());
        }
    }

    @Override
    public void update(java.util.Collection<ExecutionResumeTask> models) {
        if (models != null) models.forEach(this::updateById);
    }

    @Override
    protected ExecutionResumeTaskPO toPO(ExecutionResumeTask model) {
        if (model == null) return null;
        return ExecutionResumeTaskPO.builder()
                .id(model.getId())
                .executionId(model.getExecutionId())
                .generation(model.getGeneration())
                .state(model.getState() == null ? null : model.getState().dbValue())
                .attempts(model.getAttempts())
                .nextAttemptAt(toLocalDateTime(model.getNextAttemptAt()))
                .errorReason(model.getErrorReason())
                .version(model.getVersion())
                .createdAt(toLocalDateTime(model.getCreatedAt()))
                .updatedAt(toLocalDateTime(model.getUpdatedAt()))
                .build();
    }

    @Override
    protected ExecutionResumeTask toModel(ExecutionResumeTaskPO po) {
        if (po == null) return null;
        return ExecutionResumeTask.builder()
                .id(po.getId())
                .executionId(po.getExecutionId())
                .generation(po.getGeneration() == null ? 0L : po.getGeneration())
                .state(ResumeTaskState.parse(po.getState()))
                .attempts(po.getAttempts() == null ? 0 : po.getAttempts())
                .nextAttemptAt(toInstant(po.getNextAttemptAt()))
                .errorReason(po.getErrorReason())
                .version(po.getVersion() == null ? 1L : po.getVersion())
                .createdAt(toInstant(po.getCreatedAt()))
                .updatedAt(toInstant(po.getUpdatedAt()))
                .build();
    }

    private static LocalDateTime toLocalDateTime(Instant instant) {
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
    }

    private static Instant toInstant(LocalDateTime time) {
        return time == null ? null : time.atZone(ZoneId.systemDefault()).toInstant();
    }

    @Override
    protected @NotNull BaseMapper<ExecutionResumeTaskPO> mapper() {
        return taskMapper;
    }
}

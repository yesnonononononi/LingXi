package com.summit.dp.task.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.TaskPage;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import jakarta.validation.constraints.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;

/** 恢复任务时必须同时还原输出与完成时间，不能只恢复状态。 */
@Repository
public class TaskRepositoryImpl extends AbstractRepository<Task, TaskPO, Long>
        implements TaskRepository {

    private final TaskMapper mapper;

    public TaskRepositoryImpl(TaskMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected @NotNull BaseMapper<TaskPO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<Task> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public TaskPage queryPageBySessionId(int current, int size, long sessionId) {
        IPage<TaskPO> page = mapper.selectPage(new Page<TaskPO>(current, size),
                new LambdaQueryWrapper<TaskPO>().eq(TaskPO::getSessionId, sessionId).orderByDesc(TaskPO::getId));
        return new TaskPage(page.getCurrent(), page.getSize(), page.getTotal(), page.getRecords().stream().map(this::toModel).toList());
    }

    @Override
    protected Task toModel(TaskPO po) {
       return Task.builder()
               .id(po.getId())
               .sessionId(po.getSessionId())
               .turnId(po.getTurnId())
               .executionId(po.getExecutionId())
               .command(po.getCommand())
               .intention(po.getIntention())
               .status(Task.TaskStatus.valueOf(po.getStatus()))
               .output(po.getOutput()).exitCode(po.getExitCode()).truncated(po.isTruncated())
               .createAt(po.getCreateAt()).completeAt(po.getCompleteAt())
               .build();
    }

    @Override
    protected TaskPO toPO(Task model) {
        TaskPO po = new TaskPO();
        BeanUtils.copyProperties(model, po);
        po.setStatus(model.getStatus().name());
        return po;
    }
    @Override
    public List<Task> findUnfinished() {
        return mapper.selectList(new LambdaQueryWrapper<TaskPO>().in(TaskPO::getStatus, "PENDING", "RUNNING"))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<Task> findActiveBySessionId(long sessionId) {
        return mapper.selectList(new LambdaQueryWrapper<TaskPO>().eq(TaskPO::getSessionId, sessionId)
                .in(TaskPO::getStatus, "PENDING", "RUNNING").orderByDesc(TaskPO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<Task> findByExecutionId(long sessionId, long executionId) {
        return mapper.selectList(new LambdaQueryWrapper<TaskPO>().eq(TaskPO::getSessionId, sessionId)
                        .eq(TaskPO::getExecutionId, executionId).orderByAsc(TaskPO::getId))
                .stream().map(this::toModel).toList();
    }
}

package com.summit.dp.task.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.TaskPage;
import com.summit.dp.task.domain.model.TaskSummary;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import jakarta.validation.constraints.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Arrays;
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

    /**
     * 摘要分页：投影除 {@code output} 外的展示列。
     *
     * <p>分页仍走项目既有的 {@code selectPage} + H2 方言拦截器；列裁剪只作用在 SELECT 列表上，
     * count 语句由框架自己生成，不受影响。</p>
     */
    @Override
    public List<TaskSummary> queryPageSummaryBySessionId(int current, int size, long sessionId) {
        IPage<TaskPO> page = mapper.selectPage(new Page<TaskPO>(current, size),
                summaryColumns().eq(TaskPO::getSessionId, sessionId).orderByDesc(TaskPO::getId));
        return page.getRecords().stream().map(this::toSummary).toList();
    }

    @Override
    public List<TaskSummary> findActiveSummaryBySessionId(long sessionId) {
        return mapper.selectList(summaryColumns()
                        .eq(TaskPO::getSessionId, sessionId)
                        .in(TaskPO::getStatus, "PENDING", "RUNNING")
                        .orderByDesc(TaskPO::getId))
                .stream().map(this::toSummary).toList();
    }

    /**
     * 「可能仍有终态结果待注入」的候选会话：终态集合由域枚举推导，
     * 「已注入」的完成状态由 {@link ExecutionStatusCodes#COMPLETED} 传入，SQL 里不写字面量。
     *
     * <p>判据只认「在任务完成之后<b>才开始</b>、且正常完成」的执行（见
     * {@code TaskMapper#selectSessionIdsWithUnconsumedTerminalTasks} 的取舍说明）：
     * 用 {@code completed_at} 会把「任务在某一轮最后一次模型调用之后完成」的会话误判为已注入。</p>
     *
     * <p>不做逐会话查询：一条语句取出全部候选，候选数与历史会话总数无关。</p>
     */
    @Override
    public List<Long> findSessionIdsWithUnconsumedTerminalTasks() {
        List<String> terminalStatuses = Arrays.stream(Task.TaskStatus.values())
                .filter(Task.TaskStatus::isTerminal)
                .map(Enum::name)
                .toList();
        return mapper.selectSessionIdsWithUnconsumedTerminalTasks(terminalStatuses,
                ExecutionStatusCodes.COMPLETED);
    }

    /** 列表展示列（不含 {@code output}）：裁剪口径只在这一处定义，两个摘要查询共用。 */
    private static LambdaQueryWrapper<TaskPO> summaryColumns() {
        return new LambdaQueryWrapper<TaskPO>().select(
                TaskPO::getId, TaskPO::getSessionId, TaskPO::getTurnId,
                TaskPO::getCommand, TaskPO::getIntention, TaskPO::getStatus,
                TaskPO::getExitCode, TaskPO::isTruncated, TaskPO::getCreateAt, TaskPO::getCompleteAt);
    }

    private TaskSummary toSummary(TaskPO po) {
        return new TaskSummary(po.getId(), po.getSessionId(), po.getTurnId(), po.getCommand(),
                po.getIntention(), Task.TaskStatus.valueOf(po.getStatus()), po.getExitCode(),
                po.isTruncated(), po.getCreateAt(), po.getCompleteAt());
    }
}

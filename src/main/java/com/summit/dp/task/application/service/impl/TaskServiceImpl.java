package com.summit.dp.task.application.service.impl;

import com.summit.dp.task.domain.model.TaskPage;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.application.command.TaskCommand;
import com.summit.dp.task.application.service.TaskService;
import com.summit.dp.task.application.service.TaskRuntimeService;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;

import java.util.Collection;
import java.util.List;
import java.util.Objects;

/**
 * 查询持久化事实；删除必须经过运行时，避免留下失去记录的进程。
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class TaskServiceImpl implements TaskService {

    private final TaskRepository repository;
    private final TaskRuntimeService runtime;

    @Override
    public Result<TaskVO> findById(Long id) {
        throwIf(id == null, "任务标识不能为空");
        return Result.success(toVO(repository.findById(id).orElseThrow(ClientException::new)));
    }

    @Override
    public Result<PageResult<TaskVO>> findPage(Integer page, Integer pageSize,Long sessionId) {
        int current = page == null ? 1 : Math.max(page, 1);
        int size = pageSize == null ? 10 : Math.max(pageSize, 1);

        throwIf(sessionId == null, "会话标识不能为空");

        TaskPage pageResult = repository.queryPageBySessionId(current, size, sessionId);

        PageResult<TaskVO> result = new PageResult<>(pageResult.current(), pageResult.size(),
                pageResult.total(), pageResult.records().stream().map(this::toVO).toList());
        return Result.success(result);
    }

    @Override
    public Result<Void> add(TaskCommand command) {
        return Result.error("后台任务由终端执行工具创建，不能手工新增记录");
    }

    @Override
    public Result<Void> update(TaskCommand command) {
        return Result.error("后台任务状态和输出由运行时维护，不能手工修改");
    }

    @Override
    public Result<Void> delById(Long id) {
        throwIf(id == null, "任务标识不能为空");
        Task task = repository.findById(id).orElseThrow(ClientException::new);
        runtime.deleteTask(task.getSessionId(), id);
        return Result.success();
    }

    @Override
    public Result<List<TaskVO>> queryIn(Collection<Long> ids) {
        if (ids == null || ids.isEmpty())
            return Result.success(List.of());
        return Result.success(repository.findList(ids).stream().map(this::toVO).toList());
    }

    private TaskVO toVO(Task model) {
        TaskVO vo = new TaskVO();
        BeanUtils.copyProperties(model, vo);
        vo.setStatus(Objects.toString(model.getStatus(), null));
        return vo;
    }

    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}

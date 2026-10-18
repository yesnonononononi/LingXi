package com.summit.dp.task.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.task.application.command.TaskCommand;
import com.summit.dp.task.application.vo.TaskVO;

import java.util.Collection;
import java.util.List;

/**
 * Task 应用层服务接口（生成骨架）
 */
public interface TaskService {
    Result<TaskVO> findById(Long id);

    Result<PageResult<TaskVO>> findPage(Integer page, Integer pageSize,Long sessionId);

    Result<Void> add(TaskCommand command);

    Result<Void> update(TaskCommand command);

    Result<Void> delById(Long id);

    Result<List<TaskVO>> queryIn(Collection<Long> ids);
}

package com.summit.dp.task.application.service;

import com.summit.dp.task.application.vo.TaskVO;
import java.util.List;

/** 任务控制由运行时实现，接口层只依赖业务契约。 */
public interface TaskRuntimeService {
    TaskVO read(Long sessionId, Long taskId,boolean join);
    List<TaskVO> listTasks(Long sessionId);
    TaskVO stop(Long sessionId, Long taskId);
    void deleteTask(Long sessionId, Long taskId);
}

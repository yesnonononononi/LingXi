package com.summit.dp.task.application.service;

import com.summit.dp.task.application.vo.TaskVO;
import java.util.List;

/** 任务控制由运行时实现，接口层只依赖业务契约。 */
public interface TaskRuntimeService {
    TaskVO readTask(Long sessionId, Long taskId);
    List<TaskVO> listTasks(Long sessionId);
    TaskVO stop(Long sessionId, Long taskId);
}

package com.summit.dp.task.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.task.application.service.TaskRuntimeService;
import com.summit.dp.task.application.vo.TaskVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/** 运行中输出以进程句柄为准，结束后读取持久化结果。 */
@RestController
@RequestMapping("/task/runtime")
@RequiredArgsConstructor
public class BackgroundTaskController {
    private final TaskRuntimeService manager;

    @GetMapping("/list")
    public Result<List<TaskVO>> list(@RequestParam Long sessionId) {
        return Result.success(manager.listTasks(sessionId));
    }

    @GetMapping("/{id}")
    public Result<TaskVO> read(@RequestParam Long sessionId, @PathVariable Long id) {
        return Result.success(manager.read(sessionId, id, false));
    }

    @PostMapping("/{id}/stop")
    public Result<TaskVO> stop(@RequestParam Long sessionId, @PathVariable Long id) {
        return Result.success(manager.stop(sessionId, id));
    }

    @DeleteMapping("/{id}")
    public Result<Void> delete(@RequestParam Long sessionId, @PathVariable Long id) {
        manager.deleteTask(sessionId, id);
        return Result.success();
    }
}

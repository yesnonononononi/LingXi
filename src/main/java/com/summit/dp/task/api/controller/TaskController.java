package com.summit.dp.task.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.task.api.request.TaskRequest;
import com.summit.dp.task.application.command.TaskCommand;
import com.summit.dp.task.application.service.TaskService;
import com.summit.dp.task.application.vo.TaskVO;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Task 接口层（生成骨架）
 */
@RestController
@RequestMapping("/task")
@RequiredArgsConstructor
public class TaskController {
    private final TaskService service;

    @GetMapping("/find/{id}")
    public Result<TaskVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }



    @GetMapping("/list")
    public Result<PageResult<TaskVO>> listPage(
            @RequestParam(defaultValue = "1") Integer page,
            @RequestParam(defaultValue = "10") Integer pageSize,
            @RequestParam Long sessionId
    ) {
        return service.findPage(page, pageSize,sessionId);
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody TaskRequest request) {
        return service.add(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody TaskRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.delById(id);
    }

    private TaskCommand toCommand(TaskRequest request) {
        TaskCommand command = new TaskCommand();
        BeanUtils.copyProperties(request, command);
        return command;
    }
}

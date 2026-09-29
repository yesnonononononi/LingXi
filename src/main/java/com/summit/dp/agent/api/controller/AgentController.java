package com.summit.dp.agent.api.controller;

import com.summit.ddd.DddCodeGenerator;
import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.AgentCommand;
import com.summit.dp.agent.api.request.AgentRequest;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Path;

/** Agent 接口层（生成骨架） */
@RestController
@RequestMapping("/agent")
@RequiredArgsConstructor
public class AgentController {
    private final AgentService service;

    @GetMapping("/find/{id}")
    public Result<AgentVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @GetMapping("/list")
    public Result<PageResult<AgentVO>> listPage(
            @RequestParam(defaultValue = "1") Integer page,
            @RequestParam(defaultValue = "10") Integer pageSize) {
        return service.findPage(page, pageSize);
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody AgentRequest request) {
        return service.add(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody AgentRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.delById(id);
    }

    private AgentCommand toCommand(AgentRequest request) {
        AgentCommand command = new AgentCommand();
        BeanUtils.copyProperties(request, command);
        return command;
    }

}

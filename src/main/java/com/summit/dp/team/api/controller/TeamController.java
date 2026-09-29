package com.summit.dp.team.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.team.application.command.TeamCommand;
import com.summit.dp.team.api.request.TeamRequest;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Team 接口层（生成骨架） */
@RestController
@RequestMapping("/team")
@RequiredArgsConstructor
public class TeamController {
    private final TeamService service;

    @GetMapping("/find/{id}")
    public Result<TeamVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @GetMapping("/list")
    public Result<PageResult<TeamVO>> listPage(
            @RequestParam(defaultValue = "1") Integer page,
            @RequestParam(defaultValue = "10") Integer pageSize) {
        return service.findPage(page, pageSize);
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody TeamRequest request) {
        return service.add(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody TeamRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.delById(id);
    }

    private TeamCommand toCommand(TeamRequest request) {
        TeamCommand command = new TeamCommand();
        BeanUtils.copyProperties(request, command);
        return command;
    }
}

package com.summit.dp.session.api.controller;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.api.dto.SessionRequest;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.vo.SessionVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/session")
@RequiredArgsConstructor
public class SessionController {
    private final SessionService sessionService;

    @GetMapping("/list")
    public Result<Page<SessionVO>> list(Integer page, Integer pageSize) {
        return sessionService.list(page, pageSize);
    }

    @GetMapping("/find/{id}")
    public Result<SessionVO> findById(@PathVariable Long id) {
        return sessionService.findById(id);
    }

    @PostMapping("/add")
    public Result<Long> add(@RequestBody SessionRequest request) {
        return sessionService.add(new SessionCommand(request.id(), request.name(), request.workspaceId()));
    }

    @GetMapping("/del")
    public Result<Void> del(Long id) {
        return sessionService.del(id);
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody SessionRequest request) {
        return sessionService.update(new SessionCommand(request.id(), request.name(), request.workspaceId()));
    }
}

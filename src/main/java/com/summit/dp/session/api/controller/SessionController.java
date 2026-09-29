package com.summit.dp.session.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.api.dto.SessionRequest;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionTreeVO;
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

    @PostMapping("/create")
    public Result<Long> create(@RequestBody SessionRequest sessionRequest){
        // /session/create 不开放团队绑定：teamId 由聊天编排（ChatCommand）在会话创建那一刻写入，
        // 与 workspace 的「绑定只在创建时确定」语义一致；此处显式传 null。
        return sessionService.initialize(
                sessionRequest.name(),
                sessionRequest.workspaceId(),
                null
        );
    }

    @GetMapping("/list")
    public Result<PageResult<SessionVO>> list(Integer page, Integer pageSize) {
        return sessionService.list(page, pageSize);
    }

    @GetMapping("/{id}/messages")
    public Result<SessionMessagePageVO> messages(@PathVariable Long id, String cursor, Integer size) {
        return sessionService.messages(id, cursor, size);
    }

    /**
     * 会话树：一次返回根会话 + 其下全部子会话（平铺列表）。
     * 传根会话 id 或子会话 id 都可以，后端自动解析出真正的根会话；
     * 子会话详情按子会话 id 再请求 /session/{id}/messages。
     */
    @GetMapping("/{id}/tree")
    public Result<SessionTreeVO> tree(@PathVariable Long id) {
        return sessionService.tree(id);
    }

    @GetMapping("/del")
    public Result<Void> del(Long id) {
        return sessionService.del(id);
    }
    @GetMapping("/{id}")
    public Result<SessionVO> findById(@PathVariable Long id) {
        return sessionService.findById(id);
    }
    @PostMapping("/update")
    public Result<Void> update(@RequestBody SessionRequest request) {
        return sessionService.update(new SessionCommand(request.id(), request.name()));
    }
}

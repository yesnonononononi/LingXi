package com.summit.dp.session.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.service.SessionPinService;
import com.summit.dp.shared.vo.SessionVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/session")
@RequiredArgsConstructor
public class SessionPinController {
    private final SessionPinService sessionPinService;

    /**
     * 置顶 / 取消置顶共用一个端点：{@code pinned=false} 即取消，天然幂等。
     *
     * <p>子会话不接受设置（后端拒绝），侧栏也不给它入口 —— 它跟随所属根会话。</p>
     */
    @PostMapping("/{id}/pin")
    public Result<SessionVO> setPinned(@PathVariable Long id, @RequestParam boolean pinned) {
        return sessionPinService.setPinned(id, pinned);
    }
}

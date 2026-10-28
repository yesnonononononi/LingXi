package com.summit.dp.session.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.service.SessionReadService;
import com.summit.dp.shared.vo.SessionVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/session")
@RequiredArgsConstructor
public class SessionReadController {
    private final SessionReadService sessionReadService;

    @PostMapping("/{id}/read")
    public Result<SessionVO> read(@PathVariable Long id,
                                  @RequestParam(required = false) Long expectedVersion) {
        return sessionReadService.read(id, expectedVersion);
    }
}

package com.summit.dp.checklist.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 空清单返回空值，界面不需要构造临时实体。 */
@RestController
@RequestMapping("/checklist")
@RequiredArgsConstructor
public class ChecklistController {

    private final ChecklistService service;

    @GetMapping("/current")
    public Result<ChecklistVO> current(@RequestParam Long sessionId) {
        return Result.success(service.findCurrent(sessionId).orElse(null));
    }
}

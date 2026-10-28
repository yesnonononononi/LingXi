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

    /**
     * 界面常驻入口：返回会话最近一份清单，**包含已软删**，供用户审计。
     *
     * <p>与 {@code /current} 的差别写在服务层注释里：那条是「还能不能继续干」，这条是「发生过什么」。
     * 两个口径不能合并——合并后要么卡片删除即消失，要么已删清单被误当成活动清单。</p>
     */
    @GetMapping("/latest")
    public Result<ChecklistVO> latest(@RequestParam Long sessionId) {
        return Result.success(service.findLatestForDisplay(sessionId).orElse(null));
    }
}

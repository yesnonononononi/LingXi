package com.summit.dp.skill.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.skill.application.service.SkillQueryService;
import com.summit.dp.skill.application.vo.SkillVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Skill 接口层。
 * <p>端点风格与 {@code McpController} 一致；前端按 {@code /skill/list} 对接。</p>
 */
@RestController
@RequestMapping("/skill")
@RequiredArgsConstructor
public class SkillController {

    private final SkillQueryService skillQueryService;

    /** 本地 Skill 清单；能力未开启时返回空清单。 */
    @GetMapping("/list")
    public Result<List<SkillVO>> list() {
        return Result.success(skillQueryService.listSkills());
    }
}

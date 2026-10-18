package com.summit.dp.model.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.api.dto.PromptOptimizationRequest;
import com.summit.dp.model.application.service.PromptOptimizationService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 草稿优化无需创建会话，避免编辑输入时产生聊天记录。 */
@RestController
@RequestMapping("/model")
@RequiredArgsConstructor
public class PromptOptimizationController {

    private final PromptOptimizationService service;

    @PostMapping("/optimize-prompt")
    public Result<String> optimize(@RequestBody PromptOptimizationRequest request) {
        return Result.success(service.optimize(request.prompt(), request.modelId()));
    }
}

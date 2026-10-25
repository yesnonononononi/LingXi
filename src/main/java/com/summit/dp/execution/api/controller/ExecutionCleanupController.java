package com.summit.dp.execution.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionCleanupService.CleanupResult;
import com.summit.dp.execution.application.service.ExecutionCleanupService.Preview;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/execution/cleanup")
@RequiredArgsConstructor
public class ExecutionCleanupController {
    private final ExecutionCleanupService service;

    @GetMapping("/preview")
    public Result<Preview> preview() {
        return Result.success(service.preview());
    }

    @PostMapping
    public Result<CleanupResult> cleanup() {
        return Result.success(service.cleanup());
    }
}

package com.summit.dp.model.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.BatchModelCommand;
import com.summit.dp.model.application.service.BatchModelService;
import com.summit.dp.model.application.vo.BatchModelResult;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/model/batch")
@RequiredArgsConstructor
public class BatchModelController {
    private final BatchModelService service;

    @PostMapping("/add")
    public Result<BatchModelResult> add(@RequestBody BatchModelCommand command) {
        return Result.success(service.add(command));
    }
}

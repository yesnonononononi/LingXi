package com.summit.dp.model.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.api.dto.ModelConfigRequest;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;

import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RequiredArgsConstructor
@RestController
@RequestMapping("/model")
public class ModelController {
    private final ModelService modelService;

    @GetMapping("/list")
    public Result<PageResult<ModelConfigVO>> list(Integer page, Integer pageSize){
        return modelService.list(page,pageSize);
    }
    @PostMapping("/add")
    public Result<Void> add(@RequestBody ModelConfigRequest request){
        ModelConfigCommand command = new ModelConfigCommand(request.id(),request.modelName(), request.baseUrl(), request.apiKey());
        return modelService.add(command);
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody ModelConfigRequest request){
        ModelConfigCommand command = new ModelConfigCommand(request.id(), request.modelName(), request.baseUrl(), request.apiKey());
        return modelService.update(command);
    }

    @GetMapping("/find/{id}")
    public Result<ModelConfigVO> findById(@PathVariable Long id){
        return modelService.findById(id);
    }

    @GetMapping("/del")
    public Result<Void> delById(Long id){
        return modelService.del(id);
    }

}

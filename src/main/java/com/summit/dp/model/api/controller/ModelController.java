package com.summit.dp.model.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.api.dto.ModelConfigRequest;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.application.vo.ProviderModelGroupVO;

import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RequiredArgsConstructor
@RestController
@RequestMapping("/model")
public class ModelController {
    private final ModelService modelService;

    @GetMapping("/list")
    public Result<PageResult<ModelConfigVO>> list(Integer page, Integer pageSize){
        return modelService.list(page,pageSize);
    }

    /** 提供商 + 模型聚合分组；模型选中值仍是 model id。 */
    @GetMapping("/catalog")
    public Result<List<ProviderModelGroupVO>> catalog(){
        return modelService.catalog();
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody ModelConfigRequest request){
        return modelService.add(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody ModelConfigRequest request){
        return modelService.update(toCommand(request));
    }

    @GetMapping("/find/{id}")
    public Result<ModelConfigVO> findById(@PathVariable Long id){
        return modelService.findById(id);
    }

    @GetMapping("/del")
    public Result<Void> delById(Long id){
        return modelService.del(id);
    }

    private ModelConfigCommand toCommand(ModelConfigRequest request) {
        return new ModelConfigCommand(request.id(), request.modelName(), request.baseUrl(),
                request.apiKey(), request.vision(), request.providerConfigId(), request.useProvider());
    }
}

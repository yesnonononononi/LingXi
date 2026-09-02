package com.summit.dp.model.application.service;

import cn.hutool.db.PageResult;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.model.application.command.ModelConfigCommand;
import com.summit.dp.model.application.command.UpdateModelConfigCommand;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
@Slf4j
public class ModelServiceImpl implements ModelService{
    private final ModelConfigRepository modelConfigRepository;

    @Override
    public Result<Void> add(ModelConfigCommand command) {
        ModelConfig modelConfig = buildModel(command);
        modelConfigRepository.save(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> update(UpdateModelConfigCommand command) {
        ModelConfig modelConfig = modelConfigRepository.findById(command.id()).orElseThrow(ModelNoFoundException::new);
        modelConfig.update(command.modelName(), command.baseUrl(), command.apiKey());
        modelConfigRepository.updateById(modelConfig);
        return Result.success();
    }

    @Override
    public Result<Void> del(Long id) {
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        modelConfigRepository.delete(modelConfig);
        return Result.success();
    }

    @Override
    public Result<PageResult<List<ModelConfigVO>>> list(Integer page, Integer pageSize) {
        Page<ModelConfig> pRes = modelConfigRepository.page(page, pageSize);
        PageResult<List<ModelConfigVO>> result = new PageResult<>(page, pageSize, (int) pRes.getTotal());
        result.add(pRes.getRecords().stream().map(this::toVO).toList());
        return Result.success(result);
    }

    @Override
    public Result<ModelConfigVO> findById(Long id) {
        ModelConfig modelConfig = modelConfigRepository.findById(id).orElseThrow(ModelNoFoundException::new);
        return Result.success(toVO(modelConfig));
    }


    private ModelConfig buildModel(ModelConfigCommand command){
        return new ModelConfig(command.id(),command.modelName(), command.baseUrl(), command.apiKey());
    }
    private ModelConfigVO toVO(ModelConfig modelConfig){
        return ModelConfigVO.builder()
                .id(modelConfig.getId())
                .modelName(modelConfig.getModelName())
                .baseUrl(modelConfig.getBaseUrl())
                .apiKey(modelConfig.getApiKey())
                .build();
    }

}

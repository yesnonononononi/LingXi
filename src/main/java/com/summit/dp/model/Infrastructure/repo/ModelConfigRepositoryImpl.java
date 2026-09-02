package com.summit.dp.model.Infrastructure.repo;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.NotNull;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
@RequiredArgsConstructor
@Slf4j
public class ModelConfigRepositoryImpl extends AbstractRepository<ModelConfig,ModelConfigPO, Long> implements ModelConfigRepository {
    private final ModelConfigMapper modelConfigMapper;

    @Override
    protected ModelConfigPO toPO(ModelConfig modelConfig) {
        return ModelConfigPO.builder()
                .id(modelConfig.getId())
                .modelName(modelConfig.getModelName())
                .baseUrl(modelConfig.getBaseUrl())
                .apiKey(modelConfig.getApiKey())
                .build();

    }



    @Override
    protected ModelConfig toModel(ModelConfigPO modelConfigPO) {
        return new ModelConfig(modelConfigPO.getId(), modelConfigPO.getModelName(), modelConfigPO.getBaseUrl(), modelConfigPO.getApiKey());
    }

    @Override
    protected @NotNull BaseMapper<ModelConfigPO> mapper() {
        return modelConfigMapper;
    }

    @Override
    public Page<ModelConfig> page(Integer page, Integer pageSize) {
        Page<ModelConfig> res = new Page<>();
        Page<ModelConfigPO> poPage = new Page<>(page, pageSize);

        Page<ModelConfigPO> poPRes = modelConfigMapper.selectPage(poPage, null);

        List<ModelConfig> list = poPRes.getRecords()
                .stream()
                .map(this::toModel)
                .toList();

        return res.setCurrent(poPRes.getCurrent())
                .setTotal(poPRes.getTotal())
                .setSize(poPRes.getSize())
                .setRecords(list);

    }

    @Override
    public Optional<ModelConfig> findById(@NonNull Long aLong) {
        return Optional.empty();
    }
}

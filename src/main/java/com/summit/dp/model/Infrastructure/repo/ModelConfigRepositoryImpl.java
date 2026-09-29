package com.summit.dp.model.Infrastructure.repo;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.NotNull;
import org.jspecify.annotations.NonNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
@RequiredArgsConstructor
@Slf4j
public class ModelConfigRepositoryImpl extends AbstractRepository<ModelConfig, ModelConfigPO, Long> implements ModelConfigRepository {
    private final ModelConfigMapper modelConfigMapper;

    @Override
    protected ModelConfigPO toPO(ModelConfig modelConfig) {
        ModelConfigPO modelConfigPO = new ModelConfigPO();
        BeanUtils.copyProperties(modelConfig, modelConfigPO);
        return modelConfigPO;
    }

    @Override
    protected ModelConfig toModel(ModelConfigPO modelConfigPO) {
        ModelConfig modelConfig = new ModelConfig(
                modelConfigPO.getId(),
                modelConfigPO.getBaseUrl(),
                modelConfigPO.getApiKey(),
                modelConfigPO.getModelName(),
                modelConfigPO.getProvider()
        );
        BeanUtils.copyProperties(modelConfigPO, modelConfig);
        return modelConfig;
    }

    @Override
    protected @NotNull BaseMapper<ModelConfigPO> mapper() {
        return modelConfigMapper;
    }

    @Override
    public IPage<ModelConfig> page(Integer page, Integer pageSize) {
       return   queryByPage(page,pageSize);
    }

    @Override
    public Long saveAndReturnId(ModelConfig entity) {
        Number id = save(entity, ModelConfigPO::getId);
        return id == null ? null : id.longValue();
    }

    @Override
    public Optional<ModelConfig> findById(@NonNull Long id) {
        ModelConfigPO po = modelConfigMapper.selectById(id);
        return Optional.ofNullable(po).map(this::toModel);
    }
}

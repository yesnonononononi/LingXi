package com.summit.dp.model.Infrastructure.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;

import lombok.extern.slf4j.Slf4j;

import org.jspecify.annotations.NonNull;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

@Repository
@Slf4j
public class ModelConfigRepositoryImpl extends AbstractJsonRepository<ModelConfig, ModelConfigPO> implements ModelConfigRepository {
    public ModelConfigRepositoryImpl(ModelConfigMapper mapper,
                                     @Value("${lingxi.config.model.path:${user.home}/.lingxi/config/models.json}") String path) {
        super(Path.of(path), ModelConfigPO.class, () -> mapper.selectList(null));
    }

    @Override
    protected Long resolveId(ModelConfigPO po) { return po.getId(); }

    @Override
    protected ModelConfigPO prepareInsert(ModelConfigPO po, long id) {
        po.setId(id);
        if (po.getCreateTime() == null) po.setCreateTime(Instant.now());
        po.setUpdateTime(Instant.now());
        return po;
    }

    @Override
    protected ModelConfigPO prepareUpdate(ModelConfigPO previous, ModelConfigPO replacement) {
        replacement.setCreateTime(previous.getCreateTime());
        replacement.setUpdateTime(Instant.now());
        return replacement;
    }

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
                modelConfigPO.getProvider(),
                modelConfigPO.getProviderConfigId(),
                modelConfigPO.isVision()
        );
        BeanUtils.copyProperties(modelConfigPO, modelConfig);
        return modelConfig;
    }

    @Override
    public IPage<ModelConfig> page(Integer page, Integer pageSize) {
       return   queryByPage(page,pageSize);
    }

    @Override
    public List<ModelConfig> findAll() {
        return store.access(false, records -> records.stream()
                .sorted(Comparator.comparing(ModelConfigPO::getId, Comparator.nullsLast(Long::compareTo)))
                .map(this::toModel).toList());
    }

    @Override
    public Long saveAndReturnId(ModelConfig entity) {
        Number id = save(entity, ModelConfigPO::getId);
        return id == null ? null : id.longValue();
    }

    @Override
    public Optional<ModelConfig> findById(@NonNull Long id) {
        return super.findById(id);
    }
}

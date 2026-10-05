package com.summit.dp.model.Infrastructure.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.fasterxml.jackson.core.type.TypeReference;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.ddd.infrastructure.repository.yaml.AbstractYamlRepository;
import com.summit.ddd.infrastructure.repository.yaml.YamlListStore;
import com.summit.dp.shared.utils.YamlSerializer;

import lombok.extern.slf4j.Slf4j;

import org.jspecify.annotations.NonNull;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
@Slf4j
public class ModelConfigRepositoryImpl extends AbstractYamlRepository<ModelConfig, ModelConfigPO> implements ModelConfigRepository {
    public ModelConfigRepositoryImpl(ModelConfigMapper mapper, YamlSerializer serializer,
                                     @Value("${lingxi.config.model.path:${user.home}/.lingxi/config/models.yaml}") String path) {
        super(new YamlListStore<>(Path.of(path), serializer.listCodec(new TypeReference<List<ModelConfigPO>>() {}),
                () -> mapper.selectList(null)));
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
                modelConfigPO.getProvider()
        );
        BeanUtils.copyProperties(modelConfigPO, modelConfig);
        return modelConfig;
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
        return super.findById(id);
    }
}

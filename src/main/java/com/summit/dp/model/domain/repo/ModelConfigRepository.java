package com.summit.dp.model.domain.repo;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.model.domain.model.ModelConfig;

public interface ModelConfigRepository extends RepositoryTemplate<ModelConfig,Long> {
    Page<ModelConfig> page(Integer page, Integer pageSize);
}

package com.summit.dp.model.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.model.domain.model.ModelConfig;

public interface ModelConfigRepository extends RepositoryTemplate<ModelConfig,Long> {
    IPage<ModelConfig> page(Integer page, Integer pageSize);

    /** 返回稳定 ID，供用户设置和 Agent 引用。 */
    Long saveAndReturnId(ModelConfig entity);
}

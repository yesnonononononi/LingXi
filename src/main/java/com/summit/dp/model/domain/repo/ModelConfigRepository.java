package com.summit.dp.model.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.model.domain.model.ModelConfig;

public interface ModelConfigRepository extends RepositoryTemplate<ModelConfig,Long> {
    IPage<ModelConfig> page(Integer page, Integer pageSize);

    /** 新增模型配置并返回数据库自增 id。 */
    Long saveAndReturnId(ModelConfig entity);
}

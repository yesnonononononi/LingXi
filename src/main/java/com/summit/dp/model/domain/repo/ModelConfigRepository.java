package com.summit.dp.model.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.model.domain.model.ModelConfig;

import java.util.List;

public interface ModelConfigRepository extends RepositoryTemplate<ModelConfig,Long> {
    IPage<ModelConfig> page(Integer page, Integer pageSize);

    /** 全量列表：提供商聚合分组一次取完，避免分页接口拿不全。 */
    List<ModelConfig> findAll();

    /** 返回稳定 ID，供用户设置和 Agent 引用。 */
    Long saveAndReturnId(ModelConfig entity);
}

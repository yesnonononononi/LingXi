package com.summit.dp.provider.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.provider.domain.model.ProviderConfig;

import java.util.List;

public interface ProviderConfigRepository extends RepositoryTemplate<ProviderConfig, Long> {
    Long saveAndReturnId(ProviderConfig config);

    /** 全量列表：聚合查询与下拉分组一次取完，按 sortOrder、名称排序。 */
    List<ProviderConfig> findAll();

    /** 名称唯一性校验（更新时 excludeId 排除自身）。 */
    boolean existsByName(String name, Long excludeId);
}

package com.summit.dp.personalization.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.personalization.domain.model.Personalization;

import java.util.Collection;

/**
 * Personalization 领域仓储（生成骨架）
 */
public interface PersonalizationRepository extends RepositoryTemplate<Personalization, Long> {

    /**
     * 按标识集合批量查询（生成骨架，供应用层 queryIn 使用）
     */
    Collection<Personalization> findList(Collection<Long> ids);
}

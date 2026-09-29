package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionContext;

import java.util.List;

public interface SessionContextRepository extends RepositoryTemplate<SessionContext, Long> {
    void batchDeleteBySessionIds(List<Long> sessionIds);
}

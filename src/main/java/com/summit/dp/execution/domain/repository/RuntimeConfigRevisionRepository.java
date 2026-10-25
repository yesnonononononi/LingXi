package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.RuntimeConfigRevision;

import java.util.Optional;

public interface RuntimeConfigRevisionRepository extends RepositoryTemplate<RuntimeConfigRevision, Long> {
    Optional<RuntimeConfigRevision> findRevision(String kind, long configId, int revision);
    Optional<RuntimeConfigRevision> findMatching(String kind, long configId, String fingerprint);
    int latestRevision(String kind, long configId);
}

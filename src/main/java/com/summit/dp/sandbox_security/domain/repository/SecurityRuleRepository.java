package com.summit.dp.sandbox_security.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.sandbox_security.domain.model.SecurityRuleSet;
import java.util.List;

public interface SecurityRuleRepository extends RepositoryTemplate<SecurityRuleSet, Long> {
    SecurityRuleSet current();
    SecurityRuleSet replace(long expectedRevision, List<SecurityRule> rules);
}

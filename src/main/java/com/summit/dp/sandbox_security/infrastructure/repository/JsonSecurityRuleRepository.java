package com.summit.dp.sandbox_security.infrastructure.repository;

import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.sandbox_security.domain.model.SecurityRevisionConflictException;
import com.summit.dp.sandbox_security.domain.model.SecurityRuleSet;
import com.summit.dp.sandbox_security.domain.repository.SecurityRuleRepository;
import com.summit.dp.sandbox_security.infrastructure.persistence.SecurityRuleSetPO;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Supplier;

/** 比较版本与替换在同一文件锁内完成，失败时不会写入半套规则。 */
public class JsonSecurityRuleRepository extends AbstractJsonRepository<SecurityRuleSet, SecurityRuleSetPO>
        implements SecurityRuleRepository {
    public JsonSecurityRuleRepository(Path path, Supplier<List<SecurityRule>> defaults) {
        super(path, SecurityRuleSetPO.class,
                () -> List.of(new SecurityRuleSetPO(SecurityRuleSet.SINGLETON_ID, 0, defaults.get())));
    }
    @Override public SecurityRuleSet current() {
        return findById(SecurityRuleSet.SINGLETON_ID).orElseThrow(() -> new IllegalStateException("安全规则表缺少配置行"));
    }
    @Override public SecurityRuleSet replace(long expectedRevision, List<SecurityRule> rules) {
        return store.access(true, records -> {
            if (records.size() != 1 || records.getFirst().id() != SecurityRuleSet.SINGLETON_ID) {
                throw new IllegalStateException("安全规则表结构不正确");
            }
            SecurityRuleSet current = toModel(records.getFirst());
            if (current.getRevision() != expectedRevision) throw new SecurityRevisionConflictException();
            current.replaceRules(rules);
            records.set(0, toPO(current));
            return current;
        });
    }
    @Override protected Long resolveId(SecurityRuleSetPO po) { return po.id(); }
    @Override protected SecurityRuleSetPO prepareInsert(SecurityRuleSetPO po, long id) {
        if (id != SecurityRuleSet.SINGLETON_ID) throw new IllegalArgumentException("安全规则表 ID 必须为 1");
        return new SecurityRuleSetPO(id, po.revision(), po.rules());
    }
    @Override protected SecurityRuleSetPO prepareUpdate(SecurityRuleSetPO previous, SecurityRuleSetPO replacement) {
        return replacement;
    }
    @Override protected SecurityRuleSet toModel(SecurityRuleSetPO po) {
        return new SecurityRuleSet(po.id(), po.revision(), po.rules());
    }
    @Override protected SecurityRuleSetPO toPO(SecurityRuleSet model) {
        return new SecurityRuleSetPO(model.getId(), model.getRevision(), model.getRules());
    }
}

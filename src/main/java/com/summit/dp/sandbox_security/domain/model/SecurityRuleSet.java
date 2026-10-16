package com.summit.dp.sandbox_security.domain.model;

import java.util.List;
import lombok.Getter;

/** 整套规则统一版本，防止设置窗口之间覆盖尚未看到的修改。 */
@Getter
public final class SecurityRuleSet {
    public static final long SINGLETON_ID = 1L;
    private final Long id;
    private long revision;
    private List<SecurityRule> rules;
    public SecurityRuleSet(Long id, long revision, List<SecurityRule> rules) {
        this.id = id;
        this.revision = revision;
        this.rules = List.copyOf(rules);
    }
    public void replaceRules(List<SecurityRule> replacement) {
        rules = List.copyOf(replacement);
        revision = Math.addExact(revision, 1);
    }
}

package com.summit.dp.sandbox_security.application;

import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import org.springframework.stereotype.Component;
import java.util.Locale;
import java.util.regex.Pattern;

/** 程序名检查采用保守匹配；不声称识别脚本内部的子进程。 */
@Component
public final class TerminalSecurityPolicy {
    private final SecurityRuleService rules;
    public TerminalSecurityPolicy(SecurityRuleService rules) { this.rules = rules; }
    public SecurityDecision evaluate(String command) {
        if (command == null || command.isBlank()) return null;
        SecurityDecision first = null;
        for (SecurityRule rule : rules.rules(SecurityCategory.TERMINAL)) {
            if (!rule.enabled() || !matches(rule, command)) continue;
            SecurityDecision decision = new SecurityDecision(rule.action(), rule.pattern());
            if (rule.action() == SecurityAction.DENY) return decision;
            if (first == null) first = decision;
        }
        return first;
    }
    private boolean matches(SecurityRule rule, String command) {
        if (rule.matchType().equals("PREFIX")) {
            String normalized = command.stripLeading().toLowerCase(Locale.ROOT);
            String prefix = rule.pattern().toLowerCase(Locale.ROOT);
            return normalized.startsWith(prefix) && (normalized.length() == prefix.length()
                    || Character.isWhitespace(normalized.charAt(prefix.length()))
                    || ";&|<>".indexOf(normalized.charAt(prefix.length())) >= 0);
        }
        String program = rule.pattern().replaceFirst("(?i)\\.(exe|com|cmd|bat)$", "");
        Pattern token = Pattern.compile("(?i)(?:^|[\\s;&|()\\\\/\"'])" + Pattern.quote(program)
                + "(?:\\.(?:exe|com|cmd|bat))?(?=$|[\\s;&|()\"'])");
        return token.matcher(command).find();
    }
}

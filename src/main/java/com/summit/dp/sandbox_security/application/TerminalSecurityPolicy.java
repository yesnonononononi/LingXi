package com.summit.dp.sandbox_security.application;

import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import org.springframework.stereotype.Component;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 程序名规则在「命令位置」上判定，而不是在整条命令文本上判定：
 * {@code git grep reg}、{@code Select-String -Pattern 'reg'} 这类把程序名当参数或引号内文本的检索不该被拒。
 *
 * <p>仍然保留两条保守边界：引号外任意位置出现该程序名照样拒绝（挡住 {@code cmd /c reg}、
 * {@code start reg} 这类包装绕过），引号包住的第一个 token 也按程序名比较（覆盖
 * {@code "C:\Windows\System32\reg.exe" query ...} 这种带引号的绝对路径）。</p>
 *
 * <p>不声称识别明确写在引号里的子命令（例如 {@code powershell -c "reg query ..."}）与脚本内部子进程：
 * 这类包装需要按解释器语法解析，超出保守程序名检查的职责范围。</p>
 */
@Component
public final class TerminalSecurityPolicy {
    private final SecurityRuleService rules;
    public TerminalSecurityPolicy(SecurityRuleService rules) { this.rules = rules; }
    public SecurityDecision evaluate(String command) {
        if (command == null || command.isBlank()) return null;
        SecurityDecision first = null;
        for (SecurityRule rule : rules.rules(SecurityCategory.TERMINAL)) {
            if (!rule.enabled() || !matches(rule, command)) continue;
            SecurityDecision decision = new SecurityDecision(rule.action(), rule.pattern(),
                    rule.matchType(), rule.preset());
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
        for (String token : leadingTokens(command)) {
            if (sameProgram(token, program)) return true;
        }
        return tokenPattern(program).matcher(unquoted(command)).find();
    }

    /** 程序名比较：取 basename，去掉可执行扩展名，忽略大小写。 */
    private static boolean sameProgram(String candidate, String program) {
        String normalized = candidate.replace('\\', '/');
        String name = normalized.substring(normalized.lastIndexOf('/') + 1);
        return name.replaceFirst("(?i)\\.(exe|com|cmd|bat)$", "").equalsIgnoreCase(program);
    }

    /** 引号外任意位置出现该程序名即命中；用于挡住包装命令与路径前缀。 */
    private static Pattern tokenPattern(String program) {
        return Pattern.compile("(?i)(?:^|[\\s;&|()\\\\/\"'])" + Pattern.quote(program)
                + "(?:\\.(?:exe|com|cmd|bat))?(?=$|[\\s;&|()\"'])");
    }

    /** 按 ; & && || | 与换行切段，取每段第一个 token（引号包住的整段算一个 token）。 */
    static List<String> leadingTokens(String command) {
        List<String> tokens = new ArrayList<>();
        for (String segment : segments(command)) {
            String token = leadingToken(segment);
            if (!token.isEmpty()) tokens.add(token);
        }
        return tokens;
    }

    private static List<String> segments(String command) {
        List<String> segments = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        char quote = 0;
        for (int index = 0; index < command.length(); index++) {
            char value = command.charAt(index);
            if (quote != 0) {
                current.append(value);
                if (value == quote) quote = 0;
                continue;
            }
            if (value == '"' || value == '\'') { quote = value; current.append(value); continue; }
            if (value == ';' || value == '&' || value == '|' || value == '\n' || value == '\r') {
                segments.add(current.toString());
                current.setLength(0);
                continue;
            }
            current.append(value);
        }
        segments.add(current.toString());
        return segments;
    }

    private static String leadingToken(String segment) {
        String text = segment.strip();
        if (text.isEmpty()) return "";
        char first = text.charAt(0);
        if (first == '"' || first == '\'') {
            int end = text.indexOf(first, 1);
            return end < 0 ? text.substring(1) : text.substring(1, end);
        }
        int end = 0;
        while (end < text.length() && !Character.isWhitespace(text.charAt(end))
                && "><(=".indexOf(text.charAt(end)) < 0) {
            end++;
        }
        return text.substring(0, end);
    }

    /** 去掉引号内的文本，只留引号外真正会被 shell 解析的部分。 */
    static String unquoted(String command) {
        StringBuilder text = new StringBuilder(command.length());
        char quote = 0;
        for (int index = 0; index < command.length(); index++) {
            char value = command.charAt(index);
            if (quote != 0) {
                if (value == quote) { quote = 0; text.append(' '); }
                continue;
            }
            if (value == '"' || value == '\'') { quote = value; text.append(' '); continue; }
            text.append(value);
        }
        return text.toString();
    }
}
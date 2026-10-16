package com.summit.dp.sandbox_security.application;

import com.summit.core.runtime.security.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.sandbox_security.domain.model.SecurityRuleSet;
import com.summit.dp.sandbox_security.domain.repository.SecurityRuleRepository;
import com.summit.dp.sandbox_security.domain.model.SecurityRevisionConflictException;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import java.nio.file.Path;
import java.nio.file.InvalidPathException;
import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** 校验与保存同一套规则，禁止保存没有执行能力的动作。 */
@Service
public class SecurityRuleService {
    public static final int MAX_RULES = 256;
    private final Map<SecurityCategory, SecurityRuleRepository> repositories;
    public SecurityRuleService(@Qualifier("securityFilesRepository") SecurityRuleRepository files,
                               @Qualifier("securityTerminalRepository") SecurityRuleRepository terminal,
                               @Qualifier("securityNetRepository") SecurityRuleRepository net) {
        repositories = Map.of(SecurityCategory.FILES, files, SecurityCategory.TERMINAL, terminal, SecurityCategory.NET, net);
    }
    public SecurityRuleView current(String category) {
        SecurityCategory selected = parseCategory(category);
        return view(selected, repositories.get(selected).current());
    }
    public List<SecurityRule> defaults(String category) { return SecurityRulePresets.defaults(parseCategory(category)); }
    public SecurityRuleView save(String category, SaveRules request) {
        SecurityCategory selected = parseCategory(category);
        throwIf(request == null || request.rules() == null, "安全规则不能为空");
        throwIf(request.revision() < 0, "安全规则版本无效");
        throwIf(request.rules().size() > MAX_RULES, "每类安全规则最多 256 条");
        List<SecurityRule> rules = validate(selected, request.rules());
        try { return view(selected, repositories.get(selected).replace(request.revision(), rules)); }
        catch (SecurityRevisionConflictException conflict) { throw new ClientException(conflict.getMessage()); }
    }
    private List<SecurityRule> validate(SecurityCategory category, List<SecurityRule> input) {
        List<SecurityRule> result = new ArrayList<>();
        Set<String> keys = new HashSet<>();
        for (SecurityRule rule : input) {
            throwIf(rule == null || rule.pattern() == null || rule.pattern().isBlank(), "规则匹配内容不能为空");
            String pattern = rule.pattern().trim();
            throwIf(pattern.length() > 2048 || pattern.chars().anyMatch(c -> c < 32), "规则匹配内容过长或包含控制字符");
            throwIf(rule.matchType() == null, "请选择规则匹配方式");
            String type = rule.matchType().toUpperCase(Locale.ROOT);
            switch (category) {
                case FILES -> {
                    throwIf(!type.equals("PATH"), "文件规则只支持路径及其子目录");
                    String expanded = expandPath(pattern);
                    String key;
                    try {
                        throwIf(!expanded.equals("**") && !Path.of(expanded).isAbsolute(), "保护路径必须是绝对路径，或以用户目录变量开头");
                        key = expanded.equals("**") ? "**" : Path.of(expanded).toAbsolutePath().normalize().toString();
                    } catch (InvalidPathException invalid) { throw new ClientException("保护路径包含无效字符，请填写有效的绝对路径"); }
                    if (File.separatorChar == '\\') key = key.toLowerCase(Locale.ROOT);
                    throwIf(rule.read() == null || rule.write() == null || rule.delete() == null, "请分别设置读取、写入和删除权限");
                    throwIf(rule.read() == SecurityAction.ASK || rule.write() == SecurityAction.ASK || rule.delete() == SecurityAction.ASK,
                            "第一版尚未实现文件审批，请选择允许或禁止");
                    throwIf(rule.action() != null, "文件规则应使用独立的读取、写入和删除权限");
                    throwIf(!keys.add(key), "保护路径重复");
                }
                case TERMINAL -> {
                    throwIf(!Set.of("PROGRAM", "PREFIX").contains(type), "命令规则匹配方式无效");
                    throwIf(rule.action() == null, "请选择命令规则动作");
                    throwIf(rule.read() != null || rule.write() != null || rule.delete() != null, "命令规则不支持文件操作权限");
                    throwIf(type.equals("PROGRAM") && !pattern.matches("[A-Za-z0-9_.+-]+"), "程序规则只填写程序名，不包含路径和参数");
                    throwIf(!keys.add(type + ":" + pattern.toLowerCase(Locale.ROOT)), "命令规则重复");
                }
                case NET -> {
                    throwIf(!type.equals("ANY") || !pattern.equals("**") || rule.action() != SecurityAction.ALLOW || !rule.enabled()
                            || input.size() != 1 || rule.read() != null || rule.write() != null || rule.delete() != null,
                            "第一版网络默认允许访问，尚未启用网络过滤，不能保存拦截规则");
                }
            }
            String preset = SecurityRulePresets.defaults(category).stream()
                    .filter(candidate -> candidate.pattern().equals(pattern) && candidate.matchType().equals(type))
                    .map(SecurityRule::preset).findFirst().orElse(null);
            result.add(new SecurityRule(pattern, type, rule.read(), rule.write(), rule.delete(), rule.action(), rule.enabled(), preset));
        }
        throwIf(category == SecurityCategory.NET && result.isEmpty(), "网络表必须保留默认允许规则");
        return List.copyOf(result);
    }
    public static String expandPath(String raw) {
        String path = raw.replace("%USERPROFILE%", System.getProperty("user.home"))
                .replace("${user.home}", System.getProperty("user.home"));
        if (path.equals("~")) path = System.getProperty("user.home");
        else if (path.startsWith("~/") || path.startsWith("~\\")) path = System.getProperty("user.home") + path.substring(1);
        if (path.contains("%") || path.contains("${")) throw new ClientException("路径包含不支持的环境变量，请使用绝对路径或 %USERPROFILE%");
        return path;
    }
    private SecurityCategory parseCategory(String category) {
        throwIf(category == null, "安全规则类别不能为空");
        try { return SecurityCategory.valueOf(category.toUpperCase(Locale.ROOT)); }
        catch (IllegalArgumentException invalid) { throw new ClientException("安全规则类别必须是 files、terminal 或 net"); }
    }
    private SecurityRuleView view(SecurityCategory category, SecurityRuleSet model) {
        List<SecurityAction> supported = switch (category) {
            case FILES -> List.of(SecurityAction.ALLOW, SecurityAction.DENY);
            case TERMINAL -> List.of(SecurityAction.ALLOW, SecurityAction.ASK, SecurityAction.DENY);
            case NET -> List.of(SecurityAction.ALLOW);
        };
        return new SecurityRuleView(category.name().toLowerCase(Locale.ROOT), model.getRevision(), model.getRules(), supported,
                category == SecurityCategory.TERMINAL ? SecurityAction.ASK : SecurityAction.ALLOW, "CONFIGURATION_ONLY");
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
    public record SaveRules(long revision, List<SecurityRule> rules) { }
    public record SecurityRuleView(String category, long revision, List<SecurityRule> rules,
                                   List<SecurityAction> supportedActions, SecurityAction defaultAction, String activation) { }
}

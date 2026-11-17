package com.summit.dp.sandbox_security.application;

import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import org.springframework.stereotype.Component;

import java.io.File;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.Locale;

/**
 * 「文件安全」规则的裁决器：把规则表变成每次文件访问的放行/拒绝判定。
 *
 * <p>为什么放在业务侧而不是交给沙箱：Windows 沙箱规格只接受「工作区是否可写」一个布尔，
 * 没有逐路径清单的入参（{@code WindowsWorkspaceSpec(workDir, scope, env)}），
 * 规则下发无处可去；工具调用前的策略钩子是唯一能落地的地方。</p>
 *
 * <p>语义沿用被删掉的旧沙箱：规则表是<b>拒绝清单</b> —— 命中 DENY 才拒绝，其余一律放行。
 * 因此规则之间不存在优先级，加一条 ALLOW 也不会解锁父目录下被 DENY 的子目录。</p>
 */
@Component
public class FileRuleMatcher {

    /** 本次文件访问做了什么：规则按读取、写入、删除三列分别判定。 */
    public enum Operation { READ, WRITE, DELETE }

    private final SecurityRuleService rules;

    public FileRuleMatcher(SecurityRuleService rules) {
        this.rules = rules;
    }

    /**
     * 判定一次文件访问是否被规则拒绝。
     *
     * @param target    目标文件的绝对路径
     * @param operation 读 / 写 / 删
     * @param mode      本次执行的总权限档位
     * @return 命中的拒绝规则；没有命中时返回 null（放行）
     */
    public SecurityDecision evaluate(Path target, Operation operation, AgentPermissionMode mode) {
        if (target == null || operation == null) {
            return null;
        }
        AgentPermissionMode effective = mode == null ? AgentPermissionMode.DEFAULT : mode;
        for (SecurityRule rule : rules.rules(SecurityCategory.FILES)) {
            if (rule == null || !rule.enabled()) {
                continue;
            }
            // 完全访问是用户的明确授权，产品预设不再叠加；自定义禁止仍是用户亲手画下的边界。
            if (effective.bypassesCommandApproval() && rule.preset() != null) {
                continue;
            }
            if (!matches(rule.pattern(), target)) {
                continue;
            }
            // 文件表只保存「允许/禁止」（保存入口拒绝 ASK），所以只有 DENY 会改变结果。
            if (actionOf(rule, operation) == SecurityAction.DENY) {
                return new SecurityDecision(SecurityAction.DENY, rule.pattern(), rule.matchType(), rule.preset());
            }
        }
        return null;
    }

    private SecurityAction actionOf(SecurityRule rule, Operation operation) {
        return switch (operation) {
            case READ -> rule.read();
            case WRITE -> rule.write();
            case DELETE -> rule.delete();
        };
    }

    /**
     * 规则路径是否覆盖目标路径（含其子目录）。
     *
     * <p>变量展开复用保存时的同一处实现：规则写 {@code %USERPROFILE%/.ssh} 与落库后的绝对路径
     * 只能有一种解读，两边各写一套时会出现「保存成功却永远匹配不上」。</p>
     *
     * @param pattern 规则原文（可能含 %USERPROFILE% / ~ / ${user.home}）
     * @param target  目标文件绝对路径
     * @return true = 目标在规则覆盖范围内
     */
    public boolean matches(String pattern, Path target) {
        if (pattern == null || pattern.isBlank() || target == null) {
            return false;
        }
        String expanded = SecurityRuleService.expandPath(pattern);
        if (expanded.equals("**")) {
            return true;
        }
        try {
            String base = normalize(Path.of(expanded).toAbsolutePath().normalize());
            String candidate = normalize(target.toAbsolutePath().normalize());
            // 逐段比较而不是字符串前缀：/a/b 不能匹配 /a/bc。
            return candidate.equals(base) || candidate.startsWith(base + File.separator);
        } catch (InvalidPathException invalid) {
            // 规则内容非法是保存入口的问题，这里只需保证不炸掉整次工具调用。
            return false;
        }
    }

    /** Windows 路径大小写不敏感，按小写比较；其它平台保持原样。 */
    private String normalize(Path path) {
        String text = path.toString();
        return File.separatorChar == '\\' ? text.toLowerCase(Locale.ROOT) : text;
    }
}

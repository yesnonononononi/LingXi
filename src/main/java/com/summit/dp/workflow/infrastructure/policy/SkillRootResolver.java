package com.summit.dp.workflow.infrastructure.policy;

import com.summit.dp.skill.application.service.SkillDirectoryProvider;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * Skill 根目录的解析与就绪：设置页的 {@code skillDir} 优先，yaml 配置项 {@code lingxi.skill.dir} 只作缺省。
 *
 * <p><b>为什么必须把目录建出来，而不是「不存在就不传」</b>：框架的 {@code FileSystemSkillLoader}
 * 把「配了目录却不存在」判为错误，而不是空目录（见框架用例
 * {@code invalidConfiguredDirectoryIsAnErrorRatherThanAnEmptyCatalog}）。所以业务侧只有两条路——
 * 要么根本不传 skillConfig，要么保证目录在。解析时建一次，让「传出去」这条路始终成立。</p>
 *
 * <p>目录不可用时降级为「本次运行不提供 Skill」：Skill 是可选能力，不能因为一个目录建不出来，
 * 就让每一次执行都在装配系统提示词时抛错。</p>
 *
 * <p><b>每次调用都重解析</b>：设置页改目录后要立刻生效（无需重启），因此 {@link #root()} 每次
 * 比对当前配置串，只在变化时重建 —— 既不会每轮请求都去建目录/刷日志，也不会用到陈旧目录。</p>
 */
@Slf4j
@Component
public class SkillRootResolver implements SkillDirectoryProvider {

    /** 显式给定的目录；非 null 表示固定用它，不读设置行。 */
    private final String configuredDir;

    /** 设置来源；null 表示无设置（显式目录模式，或未被 Spring 装配的测试）。 */
    private final SettingsProvider settingsProvider;

    /** 上一次解析用的配置串（null 归一为 ""），用于判断是否需要重建。 */
    private volatile String appliedDir = "";

    /** 上一次解析出的根目录；{@code null} 表示本次运行不提供 Skill。 */
    private volatile Path appliedRoot;

    /** 显式指定目录：测试与「本次运行固定用一个目录」的场景，不读设置行。 */
    public SkillRootResolver(String configuredDir) {
        this.configuredDir = configuredDir;
        this.settingsProvider = null;
    }

    @Autowired
    public SkillRootResolver(@Value("${lingxi.skill.dir:}") String configuredDir,
                             SettingsProvider settingsProvider) {
        this.configuredDir = configuredDir;
        this.settingsProvider = settingsProvider;
    }

    /** Skill 根目录；{@code null} 表示未启用。调用方据此决定是否下发 skillConfig 与 read_skill。 */
    @Override
    public Path root() {
        String raw = currentConfiguredDir();
        Path cached = appliedRoot;
        if (raw.equals(appliedDir)) {
            return cached;
        }
        return rebuild(raw);
    }

    /** 并发下只让一个线程重建；期间的重复调用直接复用结果。 */
    private synchronized Path rebuild(String raw) {
        if (raw.equals(appliedDir)) {
            return appliedRoot;
        }
        Path resolved = prepare(raw);
        appliedDir = raw;
        appliedRoot = resolved;
        return resolved;
    }

    /** 生效的配置串：设置行的 skillDir 优先，未配置才回落到 yaml 缺省。空串统一成 ""。 */
    private String currentConfiguredDir() {
        if (settingsProvider != null) {
            String configured = settingsProvider.current()
                    .map(SettingsView::skillDir)
                    .orElse(null);
            if (configured != null) {
                return configured.trim();
            }
        }
        String fallback = configuredDir == null ? "" : configuredDir.trim();
        return fallback;
    }

    private Path prepare(String configured) {
        // 置空即关闭：给部署方一个不改代码就能摘掉该能力的开关。
        if (configured == null || configured.isBlank()) {
            log.info("未配置 Skill 根目录，本次运行不加载 Skill");
            return null;
        }
        try {
            Path candidate = Path.of(configured.trim()).toAbsolutePath().normalize();
            Files.createDirectories(candidate);
            log.info("Skill 根目录已就绪: path={}", candidate);
            return candidate;
        } catch (InvalidPathException | IOException e) {
            log.error("Skill 根目录不可用，本次运行不加载 Skill: path={}", configured, e);
            return null;
        }
    }
}

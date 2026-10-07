package com.summit.dp.shared.skill;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * Skill 根目录的解析与就绪：配置项 {@code lingxi.skill.dir}（默认 {@code ~/.lingxi/skill}）。
 *
 * <p><b>为什么必须把目录建出来，而不是「不存在就不传」</b>：框架的 {@code FileSystemSkillLoader}
 * 把「配了目录却不存在」判为错误，而不是空目录（见框架用例
 * {@code invalidConfiguredDirectoryIsAnErrorRatherThanAnEmptyCatalog}）。所以业务侧只有两条路——
 * 要么根本不传 skillConfig，要么保证目录在。启动时建一次，让「传出去」这条路始终成立。</p>
 *
 * <p>目录不可用时降级为「本次运行不提供 Skill」：Skill 是可选能力，不能因为一个目录建不出来，
 * 就让每一次执行都在装配系统提示词时抛错。</p>
 */
@Slf4j
@Component
public class SkillRootResolver {

    /** 就绪的 Skill 根目录；为 {@code null} 表示本次运行不提供 Skill。 */
    private final Path root;

    public SkillRootResolver(@Value("${lingxi.skill.dir:}") String configuredDir) {
        this.root = prepare(configuredDir);
    }

    /** Skill 根目录；{@code null} 表示未启用。调用方据此决定是否下发 skillConfig 与 read_skill。 */
    public Path root() {
        return root;
    }

    private Path prepare(String configuredDir) {
        // 置空即关闭：给部署方一个不改代码就能摘掉该能力的开关。
        if (configuredDir == null || configuredDir.isBlank()) {
            log.info("未配置 Skill 根目录，本次运行不加载 Skill");
            return null;
        }
        try {
            Path candidate = Path.of(configuredDir.trim()).toAbsolutePath().normalize();
            Files.createDirectories(candidate);
            log.info("Skill 根目录已就绪: path={}", candidate);
            return candidate;
        } catch (InvalidPathException | IOException e) {
            log.error("Skill 根目录不可用，本次运行不加载 Skill: path={}", configuredDir, e);
            return null;
        }
    }
}

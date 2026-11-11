package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.compact.TokenEstimator;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.application.chat.MemoryLoader;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;

/**
 * 把项目根的项目公约并入请求记忆。
 *
 * <p>直接读文件而不经 {@code WorkspaceResolver}：解析工作区会拉起沙箱运行时，而这里只需要
 * 一份提示词文本，读失败也只是少一段记忆。</p>
 *
 * <p>超出 token 上限按行截断，并把「已截断 + 原文位置」写给模型：公约动辄几千字，
 * 全量注入会挤掉对话预算；但悄悄截断等于让模型以为公约只有前半段，所以必须明说，由它自己
 * 用 {@code read_file} 按需补看。</p>
 */
@Slf4j
@Component
@Order(10)
public class AgentsMdLoader implements MemoryLoader {

    /** 仓库里习惯写大写；Windows/macOS 大小写不敏感，Linux 敏感，因此两种都认。 */
    static final List<String> FILE_NAMES = List.of("AGENTS.md", "agents.md");

    private final TokenEstimator tokenEstimator;
    private final int maxTokens;

    public AgentsMdLoader(TokenEstimator tokenEstimator,
                          @Value("${lingxi.memory.agents.max-tokens:3000}") int maxTokens) {
        this.tokenEstimator = tokenEstimator;
        this.maxTokens = maxTokens;
    }

    @Override
    public List<String> load(WorkspaceSpec workspace) {
        String workDir = workspace == null ? null : workspace.workDir();
        if (workDir == null || workDir.isBlank()) return List.of();
        try {
            Path projectRoot = Path.of(workDir).toAbsolutePath().normalize();
            Path file = FILE_NAMES.stream().map(projectRoot::resolve)
                    .filter(Files::isRegularFile).findFirst().orElse(null);
            if (file == null) return List.of();
            String body = Files.readString(file, StandardCharsets.UTF_8).strip();
            if (body.isEmpty()) return List.of();
            // 只给正文时模型认不出它来自项目公约，补一行来源。
            return List.of("### 项目公约（" + file.getFileName() + "）\n" + bounded(body, file));
        } catch (IOException | InvalidPathException error) {
            log.warn("加载项目公约失败: workDir={}", workDir, error);
            return List.of();
        }
    }

    /**
     * 按行截断到 {@code maxTokens} 以内。
     *
     * <p>按行而不是按字符切：公约是按条目写的，切在半句话中间比少给几行更糟。
     * 估算逐行累加，行数再多个几十毫秒也换不来更大的收益。</p>
     */
    private String bounded(String body, Path file) {
        int total = tokenEstimator.estimateText(body);
        if (total <= maxTokens) return body;

        StringBuilder kept = new StringBuilder();
        int used = 0;
        for (String line : body.lines().toList()) {
            int cost = tokenEstimator.estimateText(line + "\n");
            if (used + cost > maxTokens) break;
            kept.append(line).append('\n');
            used += cost;
        }
        log.debug("项目公约已截断: path={}, totalTokens={}, keptTokens={}", file, total, used);
        return kept + "\n【已截断】项目公约原文约 " + total + " token，超过 " + maxTokens
                + " token 上限，此处只保留前 " + used + " token。剩余内容请用 read_file 打开 "
                + file.toAbsolutePath() + " 自行选择性阅读，不要臆测被省略的部分。";
    }
}
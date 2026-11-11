package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.application.chat.MemoryLoader;
import lombok.extern.slf4j.Slf4j;
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
 */
@Slf4j
@Component
public class AgentsMdLoader implements MemoryLoader {

    /** 仓库里习惯写大写；Windows/macOS 大小写不敏感，Linux 敏感，因此两种都认。 */
    static final List<String> FILE_NAMES = List.of("AGENTS.md", "agents.md");

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
            // 只给正文时模型认不出它来自项目公约，补一行来源；空文件不产生空段。
            return body.isEmpty() ? List.of() : List.of("### 项目公约（" + file.getFileName() + "）\n" + body);
        } catch (IOException | InvalidPathException error) {
            log.warn("加载项目公约失败: workDir={}", workDir, error);
            return List.of();
        }
    }
}
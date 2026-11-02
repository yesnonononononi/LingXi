package com.summit.dp.user_configs.infrastructure.fs;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.storage.H2Storage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/** 技能可在线复制，H2 数据目录必须停库后连同检查点一起搬迁。 */
@Component
@Slf4j
public class SettingsDirectoryMigrator {
    public void migrateDataDir(String fromDir, String toDir) {
        Path from = normalize(fromDir, "当前数据目录");
        Path to = normalize(toDir, "新的数据目录");
        throwIf(!from.equals(to), "H2 不支持运行期数据目录搬迁。请先停止应用，备份并复制整个数据目录（"
                + H2Storage.DATABASE_FILE_NAME + "、checkpoints 与迁移凭据），再离线修改"
                + " config/user-configs.json 中的 dataDir。目标目录=" + to);
    }

    public void migrateSkillDir(String fromDir, String toDir) {
        Path to = normalize(toDir, "新的技能目录");
        if (fromDir == null || fromDir.isBlank()) {
            // 原来就没启用 Skill：没有可搬的内容，把新目录建出来即可。
            log.warn("当前未配置技能目录，仅创建新目录: to={}", to);
            createDirectories(to);
            return;
        }
        Path from = normalize(fromDir, "当前技能目录");
        if (from.equals(to)) {
            log.info("技能目录未变化，跳过搬迁: dir={}", from);
            return;
        }
        throwIf(to.startsWith(from), "新的技能目录不能位于当前技能目录内部: " + to);
        createDirectories(to);
        if (!Files.isDirectory(from)) {
            log.warn("当前技能目录不存在，仅创建新目录: from={}", from);
            return;
        }
        try (Stream<Path> paths = Files.walk(from)) {
            List<Path> entries = paths.sorted(Comparator.naturalOrder()).toList();
            for (Path entry : entries) {
                Path destination = to.resolve(from.relativize(entry).toString());
                if (Files.isDirectory(entry)) {
                    Files.createDirectories(destination);
                } else {
                    Files.createDirectories(destination.getParent());
                    Files.copy(entry, destination, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        } catch (IOException e) {
            throw new ClientException("技能目录搬迁失败: " + e.getMessage(), e);
        }
        log.info("技能目录搬迁完成: from={}, to={}", from, to);
    }

    private Path normalize(String raw, String label) {
        throwIf(raw == null || raw.isBlank(), label + "不能为空");
        try {
            return Path.of(raw.trim()).toAbsolutePath().normalize();
        } catch (InvalidPathException e) {
            throw new ClientException(label + "不是合法路径: " + raw, e);
        }
    }

    private void createDirectories(Path directory) {
        try {
            Files.createDirectories(directory);
        } catch (IOException e) {
            throw new ClientException("目录创建失败: " + directory, e);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

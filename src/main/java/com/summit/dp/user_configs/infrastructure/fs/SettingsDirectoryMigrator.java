package com.summit.dp.user_configs.infrastructure.fs;

import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 设置目录搬迁：改 {@code dataDir} / {@code skillDir} 时把现有内容搬到新目录。
 *
 * <p><b>为什么改配置不能只改动一个字符串</b>：旧目录里躺着真数据（H2 库文件、用户的 SKILL.md），
 * 只改路径会让新目录空空如也 —— 用户看到的现象是「数据没了」。因此搬迁必须先于落库：
 * 搬失败就抛错，配置保持原样，不会出现「配置指向空目录」。</p>
 *
 * <p><b>库文件为什么用 H2 的 BACKUP 而不是文件复制</b>：库正被本进程握着，
 * 直接 copy 可能拿到写了一半的页。{@code BACKUP TO} 是在线一致性备份，
 * 取出的是「已提交状态」，与重启后打开的库对得上。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SettingsDirectoryMigrator {

    /** H2 库文件主名；搬迁只认这一族，避免把用户目录里的杂物一起复制过去。 */
    private static final String DATABASE_FILE = "lingxi.mv.db";

    private final DataSource dataSource;

    /**
     * 把当前 H2 库的一致性快照放进新目录；落库由调用方负责。
     *
     * <p>目标目录必须为空（或只含上一次搬迁留下的库文件），否则用户可能选错了地方，
     * 覆盖掉别的应用的数据 —— 宁可直接拒绝。</p>
     */
    public void migrateDataDir(String fromDir, String toDir) {
        Path from = normalize(fromDir, "当前数据目录");
        Path to = normalize(toDir, "新的数据目录");
        if (from.equals(to)) {
            log.info("数据目录未变化，跳过搬迁: dir={}", from);
            return;
        }
        ensureReusable(to);
        Path tempDir = createTempDir();
        Path backup = tempDir.resolve(DATABASE_FILE + ".zip");
        try {
            backupTo(backup);
            extractDatabase(backup, to.resolve(DATABASE_FILE));
        } finally {
            deleteQuietly(backup);
            deleteQuietly(tempDir);
        }
        log.info("数据目录搬迁完成: from={}, to={}", from, to);
    }

    /**
     * 把技能目录整棵树复制到新目录，同名文件以旧目录为准；其它文件保留不动。
     *
     * <p>不做「目标必须为空」的限制：技能目录常是用户自己攒的，清空式搬迁等于删他的文件。
     * 新目录立即生效（{@code SkillRootResolver} 每次解析当前设置），因此无需重启。</p>
     */
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
        if (to.startsWith(from)) {
            // 新目录套在旧目录里：边遍历边写入会越套越深。
            throw new ClientException("新的技能目录不能位于当前技能目录内部: " + to);
        }
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
            throw new ClientException("技能目录搬迁失败: " + e.getMessage());
        }
        log.info("技能目录搬迁完成: from={}, to={}", from, to);
    }

    /** 目标数据目录要么是空的，要么只剩上一次搬迁留下的库文件。 */
    private void ensureReusable(Path target) {
        if (Files.isRegularFile(target)) {
            throw new ClientException("目标数据目录是一个文件: " + target);
        }
        createDirectories(target);
        try (Stream<Path> children = Files.list(target)) {
            List<String> foreign = children
                    .map(path -> path.getFileName().toString())
                    .filter(name -> !isH2Artifact(name))
                    .toList();
            if (!foreign.isEmpty()) {
                throw new ClientException("目标数据目录非空（含 " + String.join("、", foreign) + "），请选择空目录");
            }
        } catch (IOException e) {
            throw new ClientException("目标数据目录不可读: " + target);
        }
    }

    /** H2 的库文件与其伴随文件（trace / lock）都形如 lingxi.*.db。 */
    private static boolean isH2Artifact(String name) {
        return name.startsWith("lingxi.") && name.endsWith(".db");
    }

    private void backupTo(Path backup) {
        // H2 只吃单引号字符串里的字面量路径：反斜杠原样传入即可，但要把引号转义掉。
        String location = backup.toAbsolutePath().toString().replace('\\', '/').replace("'", "''");
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute("BACKUP TO '" + location + "'");
        } catch (SQLException e) {
            throw new ClientException("数据目录迁移失败，数据库备份未成功: " + e.getMessage());
        }
    }

    /** 备份 zip 里的条目名带原始目录前缀，因此按后缀找库文件，落地时统一改名。 */
    private void extractDatabase(Path backup, Path target) {
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(backup))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory() || !entry.getName().endsWith(".mv.db")) {
                    continue;
                }
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
                log.info("已从备份取出库文件: entry={}, target={}", entry.getName(), target);
                return;
            }
            throw new ClientException("备份包里没有找到库文件: " + backup);
        } catch (IOException e) {
            throw new ClientException("库文件解包失败: " + e.getMessage());
        }
    }

    private Path normalize(String raw, String label) {
        if (raw == null || raw.isBlank()) {
            throw new ClientException(label + "不能为空");
        }
        try {
            return Path.of(raw.trim()).toAbsolutePath().normalize();
        } catch (InvalidPathException e) {
            throw new ClientException(label + "不是合法路径: " + raw);
        }
    }

    private void createDirectories(Path directory) {
        try {
            Files.createDirectories(directory);
        } catch (IOException e) {
            throw new ClientException("目录创建失败: " + directory);
        }
    }

    private Path createTempDir() {
        try {
            return Files.createTempDirectory("lingxi-data-move-");
        } catch (IOException e) {
            throw new ClientException("临时目录创建失败: " + e.getMessage());
        }
    }

    private void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            log.warn("临时文件清理失败: path={}", path, e);
        }
    }
}

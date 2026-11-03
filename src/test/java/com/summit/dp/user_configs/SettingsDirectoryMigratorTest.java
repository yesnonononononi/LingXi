package com.summit.dp.user_configs;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 目录搬迁的真实文件系统行为：复制的是整棵树，拒绝的是会毁数据的目录。 */
class SettingsDirectoryMigratorTest {

    @TempDir
    Path tempDir;

    private final DataSource dataSource = mock(DataSource.class);
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    /** 当前生效的数据目录（检查点存储的根就在这里）。 */
    private Path fromDir;
    private SettingsDirectoryMigrator migrator;

    @BeforeEach
    void setUp() {
        fromDir = tempDir.resolve("from");
        migrator = new SettingsDirectoryMigrator();
    }

    @Test
    @DisplayName("技能目录：连嵌套子目录一起复制，旧目录保留（搬迁失败还能退回去）")
    void skillDirCopiesWholeTreeAndKeepsSource() throws IOException {
        Path from = Files.createDirectories(tempDir.resolve("old"));
        Files.writeString(from.resolve("SKILL.md"), "根技能");
        Path nested = Files.createDirectories(from.resolve("sub/deep"));
        Files.writeString(nested.resolve("SKILL.md"), "嵌套技能");

        Path to = tempDir.resolve("new");
        migrator.migrateSkillDir(from.toString(), to.toString());

        assertEquals("根技能", Files.readString(to.resolve("SKILL.md")));
        assertEquals("嵌套技能", Files.readString(to.resolve("sub/deep/SKILL.md")));
        assertTrue(Files.exists(from.resolve("SKILL.md")), "旧目录必须保留");
    }

    @Test
    @DisplayName("技能目录：新目录套在旧目录内部直接拒绝（否则会越套越深）")
    void skillDirInsideItselfIsRejected() throws IOException {
        Path from = Files.createDirectories(tempDir.resolve("old"));
        Path to = from.resolve("nested");

        assertThrows(ClientException.class, () -> migrator.migrateSkillDir(from.toString(), to.toString()));
    }

    @Test
    @DisplayName("技能目录：原来未启用（来源为空）时只建新目录，不报错")
    void blankSkillDirSourceOnlyCreatesTarget() {
        Path to = tempDir.resolve("fresh");

        migrator.migrateSkillDir(null, to.toString());

        assertTrue(Files.isDirectory(to));
    }

    @Test
    void dataDirChangeRejectsBeforeTouchingAnyFiles() throws Exception {
        Path target = Files.createDirectories(tempDir.resolve("target"));
        Path existing = target.resolve("lingxi-h2.mv.db");
        Files.writeString(existing, "backup");
        ClientException error = assertThrows(ClientException.class,
                () -> migrator.migrateDataDir(fromDir.toString(), target.toString()));
        assertTrue(error.getMessage().contains("离线"));
        assertEquals("backup", Files.readString(existing));
        verifyNoInteractions(dataSource);
    }

    @Test
    @DisplayName("数据目录：来源与目标同一路径时直接跳过，不做任何备份")
    void sameDataDirSkipsMigration() {
        String dir = tempDir.resolve("only").toString();

        migrator.migrateDataDir(dir, dir);

        verifyNoInteractions(dataSource);
    }
}

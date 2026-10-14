package com.summit.dp.user_configs;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** 目录搬迁的真实文件系统行为：复制的是整棵树，拒绝的是会毁数据的目录。 */
class SettingsDirectoryMigratorTest {

    @TempDir
    Path tempDir;

    private final DataSource dataSource = mock(DataSource.class);
    private final SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(dataSource);

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
    @DisplayName("数据目录：目标含无关文件时拒绝，且根本不碰数据库")
    void dataDirRejectsTargetHoldingForeignFiles() throws IOException {
        Path target = Files.createDirectories(tempDir.resolve("target"));
        Files.writeString(target.resolve("我的照片.jpg"), "内容");

        ClientException error = assertThrows(ClientException.class,
                () -> migrator.migrateDataDir(tempDir.resolve("from").toString(), target.toString()));

        assertTrue(error.getMessage().contains("非空"), "报错要说清是目录非空: " + error.getMessage());
        verifyNoInteractions(dataSource);
    }

    @Test
    @DisplayName("数据目录：目标里只躺着库文件时允许复用（改回原目录的场景）")
    void dataDirAcceptsTargetHoldingOnlyH2Artifacts() throws Exception {
        Path target = Files.createDirectories(tempDir.resolve("target"));
        Files.writeString(target.resolve("lingxi.mv.db"), "");
        Files.writeString(target.resolve("lingxi.trace.db"), "");
        // 目录校验通过后才会去连库；这里让连接直接失败，用来证明「卡在备份」而不是「卡在校验」。
        when(dataSource.getConnection()).thenThrow(new SQLException("测试不接真库"));

        ClientException error = assertThrows(ClientException.class,
                () -> migrator.migrateDataDir(tempDir.resolve("from").toString(), target.toString()));

        assertTrue(error.getMessage().contains("数据库备份"), "应当已经走到备份这一步: " + error.getMessage());
    }

    @Test
    @DisplayName("数据目录：来源与目标同一路径时直接跳过，不做任何备份")
    void sameDataDirSkipsMigration() {
        String dir = tempDir.resolve("only").toString();

        migrator.migrateDataDir(dir, dir);

        verifyNoInteractions(dataSource);
    }
}

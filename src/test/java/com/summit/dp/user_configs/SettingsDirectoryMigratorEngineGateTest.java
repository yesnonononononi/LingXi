package com.summit.dp.user_configs;

import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineProperties;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 引擎闸门的补充守卫：「H2 拒绝必须发生在任何文件操作之前」。
 *
 * <p>{@code SettingsDirectoryMigratorH2Test} 用的是<b>已存在</b>的目标目录，因此它只能证明
 * 「既有文件没被删」；本用例补上更硬的一格：目标目录<b>根本不会被创建</b> ——
 * 这才是「校验 → 引擎闸门 → 才允许写盘」这个顺序的可观测证据。
 * 顺序一旦被改回「先 createDirectories 再判引擎」，本用例立刻变红。</p>
 *
 * <p>另外守住一条容易踩的分界：技能目录是纯文件、与库无关，H2 引擎下必须照常可搬
 * （否则用户换引擎后连技能目录都改不了）。</p>
 */
class SettingsDirectoryMigratorEngineGateTest {

    private final List<Path> tempDirectories = new ArrayList<>();
    private H2TestDatabase database;

    @AfterEach
    void cleanUp() {
        if (database != null) {
            database.shutdown();
            database = null;
        }
        for (Path directory : tempDirectories) {
            deleteQuietly(directory);
        }
        tempDirectories.clear();
    }

    @Test
    @DisplayName("H2 引擎：目标目录不存在时，拒绝发生在建目录之前（目录不得被创建出来）")
    void h2RejectionDoesNotCreateTargetDirectory() throws IOException {
        database = H2TestDatabase.create("gate-h2-fresh");
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(database, checkpointStore());
        Path from = newTempDirectory("gate-from");
        Path to = from.getParent().resolve("gate-target-" + System.nanoTime());

        assertThrows(ClientException.class, () -> migrator.migrateDataDir(from.toString(), to.toString()));

        assertTrue(Files.notExists(to), "H2 拒绝前不得创建目标目录（任何文件操作都必须在其之后）: " + to);
    }

    @Test
    @DisplayName("H2 引擎：技能目录搬迁不受影响，照常复制整棵树")
    void h2EngineStillAllowsSkillDirectoryMigration() throws IOException {
        database = H2TestDatabase.create("gate-h2-skill");
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(database, checkpointStore());
        Path from = Files.createDirectories(newTempDirectory("gate-skill-from").resolve("skills"));
        Files.writeString(from.resolve("SKILL.md"), "技能正文");
        Path to = from.getParent().resolve("skills-new");

        assertDoesNotThrow(() -> migrator.migrateSkillDir(from.toString(), to.toString()),
                "技能目录是纯文件，H2 引擎下必须照常可搬");
        assertEquals("技能正文", Files.readString(to.resolve("SKILL.md")));
    }

    @Test
    @DisplayName("引擎取自存储开关：开关写 h2 时，即使数据源是 SQLite 也按 H2 拒绝（开关是唯一事实源）")
    void engineComesFromStorageSwitchWhenProvided() throws IOException {
        StorageEngineProperties properties = new StorageEngineProperties();
        properties.setEngine(StorageEngine.H2);
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(
                sqliteDataSourceIn(newTempDirectory("gate-sqlite-ds")), checkpointStore(), properties);
        Path from = newTempDirectory("gate-switch-from");
        Path to = from.getParent().resolve("gate-switch-target-" + System.nanoTime());

        ClientException failure = assertThrows(ClientException.class,
                () -> migrator.migrateDataDir(from.toString(), to.toString()),
                "查询开关即应拒绝：不应再去读数据源元数据");
        assertTrue(failure.getMessage().contains("H2"), "消息必须点名 H2，实际=" + failure.getMessage());
        assertTrue(Files.notExists(to), "拒绝前不得创建目标目录");
    }

    /** 一个不落盘的 SQLite 数据源：本用例只验证开关优先级，不真的建库。 */
    private static DriverManagerDataSource sqliteDataSourceIn(Path directory) {
        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName("org.sqlite.JDBC");
        dataSource.setUrl("jdbc:sqlite:" + directory.resolve("lingxi.sqlite").toString().replace('\\', '/'));
        return dataSource;
    }

    private static ExecutionCheckpointStore checkpointStore() {
        ExecutionCheckpointStore store = mock(ExecutionCheckpointStore.class);
        doAnswer(invocation -> {
            ((Runnable) invocation.getArgument(0)).run();
            return null;
        }).when(store).withWriteQuiesced(any());
        when(store.copyTo(anyString())).thenReturn(new ExecutionCheckpointStore.CopyResult(0, 0));
        return store;
    }

    private Path newTempDirectory(String prefix) throws IOException {
        Path root = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-h2-verify");
        Files.createDirectories(root);
        Path directory = Files.createTempDirectory(root, prefix + "-");
        tempDirectories.add(directory);
        return directory;
    }

    private static void deleteQuietly(Path directory) {
        if (directory == null || !Files.exists(directory)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // 临时目录由系统兜底清理，不掩盖用例结论。
                }
            });
        } catch (IOException ignored) {
            // 同上。
        }
    }
}

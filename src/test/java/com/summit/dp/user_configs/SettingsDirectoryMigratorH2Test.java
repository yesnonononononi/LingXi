package com.summit.dp.user_configs;

import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
 * H2 引擎下的「改数据目录」必须被明确拒绝（设计 §2.2：{@code SettingsDirectoryMigrator}
 * 的 {@code DATABASE_FILE} 改引擎感知，H2 引擎下运行期目录搬迁直接拒绝并提示用离线工具）。
 *
 * <p><b>为什么这条用例值钱</b>：{@code migrateDataDir} 生成库快照用的是 SQLite 专有的
 * {@code VACUUM INTO}。H2 引擎下这条语句在 2.5.252 上是语法错误（实测 42000，见
 * {@code tools/qa/VacuumIntoProbe.java}）。如果搬迁逻辑按「先删目标残留 → 再做快照」的顺序走，
 * 用户看到的就会是一句 SQL 语法错误，而设计要求的是「明确提示用离线工具」；
 * 更糟的是目标目录里上一次搬迁留下的库文件会被先删掉，然后才失败。</p>
 *
 * <p>因此本用例钉住两件事：① 拒绝原因必须可执行（点名 H2 与离线工具）；
 * ② 失败时不得改动目标目录里的任何既有文件（不留半套产物）。</p>
 */
class SettingsDirectoryMigratorH2Test {

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
    @DisplayName("H2 引擎下改数据目录：明确拒绝并提示离线迁移工具，不得把 SQL 语法错误抛给用户")
    void h2EngineRejectsDataDirMigrationWithActionableMessage() throws IOException {
        database = H2TestDatabase.create("migrator-h2");
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(database, checkpointStore());
        Path from = newTempDirectory("migrator-from");
        Path to = newTempDirectory("migrator-to");

        ClientException failure = assertThrows(ClientException.class,
                () -> migrator.migrateDataDir(from.toString(), to.toString()),
                "H2 引擎下运行期目录搬迁必须被明确拒绝（H2 文件不能热复制，须走离线工具）");
        String message = String.valueOf(failure.getMessage());
        assertTrue(message.contains("H2") && message.contains("离线"),
                "拒绝原因必须点名 H2 并指引离线迁移工具，实际消息=" + message);
    }

    @Test
    @DisplayName("H2 引擎下搬迁失败不得动目标目录里上一次搬迁留下的库文件（不留半套产物）")
    void h2EngineMigrationFailureLeavesTargetDirectoryUntouched() throws IOException {
        database = H2TestDatabase.create("migrator-h2-side-effect");
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(database, checkpointStore());
        Path from = newTempDirectory("migrator-from");
        Path to = newTempDirectory("migrator-to");
        // 目标目录里放一个「上一次搬迁的残留」：按 ensureReusable 的规则它是允许存在的。
        Path leftover = to.resolve("lingxi.sqlite");
        Files.writeString(leftover, "上一次搬迁的残留");

        assertThrows(RuntimeException.class, () -> migrator.migrateDataDir(from.toString(), to.toString()),
                "H2 引擎下搬迁必须失败");

        assertTrue(Files.exists(leftover),
                "搬迁失败前不该先删目标目录里的既有文件（真实用户在那里可能留着可恢复的旧库）: " + leftover);
        assertEquals("上一次搬迁的残留", Files.readString(leftover), "残留文件内容不得被改写");
    }

    @Test
    @DisplayName("同目录（from == to）依然是空操作：不假装搬迁也不报错")
    void sameDirectoryIsNoOp() throws IOException {
        database = H2TestDatabase.create("migrator-h2-noop");
        SettingsDirectoryMigrator migrator = new SettingsDirectoryMigrator(database, checkpointStore());
        Path same = newTempDirectory("migrator-same");
        assertDoesNotThrow(() -> migrator.migrateDataDir(same.toString(), same.toString()),
                "数据目录未变化时必须直接返回（H2 下同样不该报错）");
    }

    /** 检查点存储用测试替身：本用例只关心搬迁编排，不关心正文复制实现。 */
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
            paths.sorted((left, right) -> right.getNameCount() - left.getNameCount()).forEach(path -> {
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

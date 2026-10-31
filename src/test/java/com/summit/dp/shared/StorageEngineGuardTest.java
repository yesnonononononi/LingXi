package com.summit.dp.shared;

import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineGuard;
import com.summit.dp.shared.storage.StorageLayout;
import com.summit.dp.shared.storage.StorageVerdict;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 启动期校验矩阵逐格断言（{@code 数据目录形态 × 引擎设置}）。
 *
 * <p>每一格都必须是「确定性行为」：要么允许启动，要么带着可执行提示拒绝启动。
 * 这些格子对应的是「用户把引擎开关写错、或迁移没做完就切引擎」的真实事故形态 ——
 * 矩阵漏一格，事故就会以「启动成功但数据全空」的方式发生。</p>
 */
class StorageEngineGuardTest {

    private final StorageEngineGuard guard = new StorageEngineGuard();
    private final List<Path> createdDirectories = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (Path directory : createdDirectories) {
            deleteQuietly(directory);
        }
        createdDirectories.clear();
    }

    @Test
    @DisplayName("空格：目录为空 → 两个引擎都是首装，且目录会被创建出来")
    void emptyDirectoryIsFirstInstall() throws IOException {
        for (StorageEngine engine : StorageEngine.values()) {
            Path dataDir = newDataDir("empty-" + engine.id());
            StorageLayout layout = new StorageLayout(dataDir.resolve("nested"), engine);
            assertEquals(StorageVerdict.FIRST_INSTALL, guard.verdict(layout, engine, true),
                    "空目录必须判定为首装: engine=" + engine.id());
            guard.requireStartable(layout, engine, true);
            assertTrue(Files.isDirectory(layout.dataDir()), "首装必须把数据目录建出来: " + layout.dataDir());
        }
    }

    @Test
    @DisplayName("sqlite 引擎 + 只有 lingxi.sqlite → READY")
    void sqliteDataWithSqliteEngineIsReady() throws IOException {
        Path dataDir = newDataDir("sqlite-ready");
        Files.writeString(dataDir.resolve("lingxi.sqlite"), "sqlite-placeholder", StandardCharsets.UTF_8);
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.SQLITE);
        assertEquals(StorageVerdict.READY, guard.verdict(layout, StorageEngine.SQLITE, true));
        guard.requireStartable(layout, StorageEngine.SQLITE, true);
    }

    @Test
    @DisplayName("sqlite 引擎 + 只有 H2 库 → 拒绝启动（不静默建空 SQLite）")
    void h2DataWithSqliteEngineIsRejected() throws IOException {
        Path dataDir = newDataDir("h2-but-sqlite");
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.SQLITE);
        assertEquals(StorageVerdict.REJECT_H2_DATA_WITH_SQLITE_ENGINE,
                guard.verdict(layout, StorageEngine.SQLITE, true));
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(layout, StorageEngine.SQLITE, true));
        assertTrue(failure.getMessage().contains("lingxi.storage.engine=h2"),
                "提示必须给出处置建议，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("h2 引擎 + 只有 SQLite 数据且无迁移凭据 → 拒绝启动")
    void sqliteDataWithH2EngineWithoutManifestIsRejected() throws IOException {
        Path dataDir = newDataDir("sqlite-but-h2");
        Files.writeString(dataDir.resolve("lingxi.sqlite"), "sqlite-placeholder", StandardCharsets.UTF_8);
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertEquals(StorageVerdict.REJECT_SQLITE_DATA_WITHOUT_MIGRATION,
                guard.verdict(layout, StorageEngine.H2, true));
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(layout, StorageEngine.H2, true));
        assertTrue(failure.getMessage().contains("Migrate-SqliteToH2"),
                "提示必须点名迁移脚本，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("h2 引擎 + 只有 H2 库 → READY")
    void h2DataWithH2EngineIsReady() throws IOException {
        Path dataDir = newDataDir("h2-ready");
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertEquals(StorageVerdict.READY, guard.verdict(layout, StorageEngine.H2, true));
    }

    @Test
    @DisplayName("两个库都在 + sqlite 引擎 → 永远拒绝（即使凭据已验证，歧义必须先清理）")
    void bothLibrariesWithSqliteEngineAreRejected() throws IOException {
        Path dataDir = newDataDir("both-sqlite");
        String sqliteSha = writeFakeSqlite(dataDir);
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        writeManifest(dataDir, true, sqliteSha);
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.SQLITE);
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, StorageEngine.SQLITE, true));
    }

    @Test
    @DisplayName("两个库都在 + h2 引擎 + 凭据通过 → READY")
    void bothLibrariesWithVerifiedManifestAreReadyForH2() throws IOException {
        Path dataDir = newDataDir("both-h2-verified");
        String sqliteSha = writeFakeSqlite(dataDir);
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        writeManifest(dataDir, true, sqliteSha);
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertTrue(guard.isMigrationVerified(layout), "凭据必须被采信");
        assertEquals(StorageVerdict.READY, guard.verdict(layout, StorageEngine.H2, true));
    }

    @Test
    @DisplayName("两个库都在 + h2 引擎 + 没有凭据 → 拒绝启动")
    void bothLibrariesWithoutManifestAreRejected() throws IOException {
        Path dataDir = newDataDir("both-h2-no-manifest");
        writeFakeSqlite(dataDir);
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertFalse(guard.isMigrationVerified(layout));
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, StorageEngine.H2, true));
    }

    @Test
    @DisplayName("凭据里的源库指纹被手改 → 不采信，拒绝启动")
    void manifestWithWrongSourceHashIsRejected() throws IOException {
        Path dataDir = newDataDir("both-h2-tampered");
        writeFakeSqlite(dataDir);
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        writeManifest(dataDir, true, "0000000000000000000000000000000000000000000000000000000000000000");
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertFalse(guard.isMigrationVerified(layout), "指纹不符必须视为未验证");
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, StorageEngine.H2, true));
    }

    @Test
    @DisplayName("凭据 verified=false → 不采信")
    void manifestWithVerifiedFalseIsRejected() throws IOException {
        Path dataDir = newDataDir("both-h2-unverified");
        String sqliteSha = writeFakeSqlite(dataDir);
        Files.write(dataDir.resolve("lingxi-h2.mv.db"), new byte[]{1, 2, 3});
        writeManifest(dataDir, false, sqliteSha);
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertFalse(guard.isMigrationVerified(layout));
        assertEquals(StorageVerdict.REJECT_AMBIGUOUS_DATA, guard.verdict(layout, StorageEngine.H2, true));
    }

    @Test
    @DisplayName("缺驱动 → 拒绝启动，且提示缺哪个 jar")
    void missingDriverIsRejected() throws IOException {
        Path dataDir = newDataDir("no-driver");
        StorageLayout layout = new StorageLayout(dataDir, StorageEngine.H2);
        assertEquals(StorageVerdict.REJECT_MISSING_DRIVER, guard.verdict(layout, StorageEngine.H2, false));
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(layout, StorageEngine.H2, false));
        assertTrue(failure.getMessage().contains("org.h2.Driver"),
                "提示必须点名缺失的驱动类，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("引擎取值非法 → 立即抛错并列出允许值；空值回落 sqlite")
    void enginePropertyParsingIsStrictButDefaultsToSqlite() {
        assertEquals(StorageEngine.SQLITE, StorageEngine.fromProperty(null));
        assertEquals(StorageEngine.SQLITE, StorageEngine.fromProperty("  "));
        assertEquals(StorageEngine.SQLITE, StorageEngine.fromProperty("SQLite"));
        assertEquals(StorageEngine.H2, StorageEngine.fromProperty(" H2 "));
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> StorageEngine.fromProperty("mysql"));
        assertTrue(failure.getMessage().contains("sqlite") && failure.getMessage().contains("h2"),
                "错误消息必须列出允许值，实际=" + failure.getMessage());
        // 宽松解析只用于告警文案：非法值回落 sqlite，由守卫统一报错。
        assertEquals(StorageEngine.SQLITE, StorageEngine.fromPropertyOrSqlite("mysql"));
    }

    @Test
    @DisplayName("数据目录建不出来 → 拒绝启动（不静默回落到别处）")
    void unusableDataDirectoryFailsFast() throws IOException {
        Path dataDir = newDataDir("blocked");
        // 用一个普通文件占住父路径，任何 createDirectories 都会失败。
        Path blocker = dataDir.resolve("blocker");
        Files.writeString(blocker, "not-a-directory", StandardCharsets.UTF_8);
        StorageLayout layout = new StorageLayout(blocker.resolve("data"), StorageEngine.SQLITE);
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> guard.requireStartable(layout, StorageEngine.SQLITE, true));
        assertTrue(failure.getMessage().contains("数据目录"),
                "提示必须指向数据目录，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("H2 库文件名/驱动/脚本位置/处理器包一次写死，不接受自由发挥")
    void engineFactsAreFixed() {
        assertEquals("lingxi.sqlite", StorageEngine.SQLITE.databaseFileName());
        assertEquals("lingxi.sqlite", StorageEngine.SQLITE.jdbcDatabaseName());
        assertEquals("org.sqlite.JDBC", StorageEngine.SQLITE.driverClassName());
        assertEquals("classpath*:db/sqlite/V*__*.sql", StorageEngine.SQLITE.schemaLocation());
        assertEquals("com.summit.dp.shared.persistence.handler.sqlite", StorageEngine.SQLITE.typeHandlerPackage());

        assertEquals("lingxi-h2.mv.db", StorageEngine.H2.databaseFileName());
        assertEquals("lingxi-h2", StorageEngine.H2.jdbcDatabaseName());
        assertEquals("org.h2.Driver", StorageEngine.H2.driverClassName());
        assertEquals("classpath*:db/h2/V*__*.sql", StorageEngine.H2.schemaLocation());
        assertEquals("com.summit.dp.shared.persistence.handler.h2", StorageEngine.H2.typeHandlerPackage());
    }

    /** 在系统临时目录下开一个隔离目录，用例结束统一删除（绝不写工作区与真实数据目录）。 */
    private Path newDataDir(String prefix) throws IOException {
        Path root = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-h2-verify");
        Files.createDirectories(root);
        Path directory = Files.createTempDirectory(root, "guard-" + prefix + "-");
        createdDirectories.add(directory);
        return directory;
    }

    /** 写一个假的 SQLite 库文件并返回它的 SHA-256（只用于凭据比对，不解码内容）。 */
    private String writeFakeSqlite(Path dataDir) throws IOException {
        Path sqliteFile = dataDir.resolve("lingxi.sqlite");
        Files.write(sqliteFile, "SQLite format 3\u0000placeholder".getBytes(StandardCharsets.UTF_8));
        return sha256(sqliteFile);
    }

    private void writeManifest(Path dataDir, boolean verified, String sourceSha256) throws IOException {
        String json = "{\"toolVersion\":\"1.0.0\",\"verified\":" + verified
                + ",\"sourceSha256\":\"" + sourceSha256 + "\",\"engine\":\"h2\"}";
        Files.writeString(dataDir.resolve("migration-from-sqlite.json"), json, StandardCharsets.UTF_8);
    }

    private static String sha256(Path file) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(Files.readAllBytes(file));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
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
                    // 清理失败不掩盖断言结果；临时目录由系统兜底。
                }
            });
        } catch (IOException ignored) {
            // 同上。
        }
    }
}

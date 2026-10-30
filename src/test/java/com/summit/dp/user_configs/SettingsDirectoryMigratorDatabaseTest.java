package com.summit.dp.user_configs;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 数据目录迁移的**真实数据库**验证。
 *
 * <p>这里要证的不是「代码调了 VACUUM INTO」，而是三件读代码看不出来的事：
 * ① 库在搬迁期间仍被本进程握着，快照是否真的与重启后打开的库一致（页面、WAL 都要合并进去）；
 * ② 从快照还原出来的库能不能在**新目录**里重新打开、原来写进去的数据（含 {@code schema_version}）还在；
 * ③ 数据集合的另一半 —— {@code checkpoints} 目录 —— 也整体搬了过去，且库里引用的正文在新位置读得到。
 * 这几点任一不成立，用户改数据目录之后看到的就是「数据没了」。</p>
 */
class SettingsDirectoryMigratorDatabaseTest {

    @TempDir
    Path tempDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();

    @Test
    @DisplayName("迁移后的库能在新目录打开，且原数据还在")
    void migratedDatabaseOpensAtNewDirectoryWithData() throws Exception {
        Path fromDir = Files.createDirectories(tempDir.resolve("from"));
        Path toDir = tempDir.resolve("to");

        DriverManagerDataSource source = dataSourceOf(fromDir);
        try (Connection connection = source.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)");
            statement.execute("INSERT INTO probe VALUES (1, '搬家前写入的数据')");
        }

        new SettingsDirectoryMigrator(source, storeOf(fromDir))
                .migrateDataDir(fromDir.toString(), toDir.toString());

        assertTrue(Files.exists(toDir.resolve("lingxi.sqlite")), "新目录里必须出现库文件");
        // 快照是单文件：不得把 -wal 里的提交留在源目录
        assertTrue(Files.notExists(toDir.resolve("lingxi.sqlite-wal")), "快照不应依赖源库的 WAL 文件");

        try (Connection connection = dataSourceOf(toDir).getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT note FROM probe WHERE id = 1")) {
            assertTrue(rows.next(), "迁移后的库里必须还能读到原来的数据");
            assertEquals("搬家前写入的数据", rows.getString(1));
        }
    }

    @Test
    @DisplayName("源目录里还没有库文件：迁移照样成功，新目录是一个可打开的空库")
    void missingSourceDatabaseStillYieldsOpenableTarget() throws Exception {
        Path fromDir = Files.createDirectories(tempDir.resolve("empty-from"));
        Path toDir = tempDir.resolve("to");

        new SettingsDirectoryMigrator(dataSourceOf(fromDir), storeOf(fromDir))
                .migrateDataDir(fromDir.toString(), toDir.toString());

        // SQLite 在建立连接时就把库文件创建出来（哪怕一行数据都没有），
        // 所以「源目录没有库文件」在生产里基本不会出现，快照出来的是一个空库 ——
        // 结果等价于全新库，重启后照样能打开。这里断言的是「新目录可用」，不是「没有库文件」。
        try (Connection connection = dataSourceOf(toDir).getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT 1")) {
            assertTrue(rows.next());
        }
    }

    /**
     * 数据集合整体搬迁的守卫：库（含 schema_version）+ checkpoints 都完整可用。
     *
     * <p>同时守住「不许把正在写入的主文件当权威数据」：迁移前故意让一行提交只落在 WAL 里
     * （不 checkpoint），直接复制主文件会丢掉它；{@code VACUUM INTO} 出来的快照必须带着它，
     * 因此迁移后的库文件字节也不等于源主文件。</p>
     */
    @Test
    @DisplayName("SQLite 库（含 schema_version）与 checkpoints 一起搬到新目录且都可用")
    void migratedDataSetKeepsSchemaVersionAndCheckpointFiles() throws Exception {
        Path fromDir = Files.createDirectories(tempDir.resolve("from"));
        Path toDir = tempDir.resolve("to");
        LocalFileCheckpointStore store = storeOf(fromDir);
        DriverManagerDataSource source = dataSourceOf(fromDir);
        byte[] sourceMainFile;
        try (Connection connection = source.getConnection()) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)");
                statement.execute("INSERT INTO schema_version VALUES (3, '2026-10-30')");
                statement.execute("CREATE TABLE execution (id INTEGER PRIMARY KEY, snapshot_file TEXT)");
            }
            // 发布一份真实检查点正文，并把文件标识写进库：这就是「库 + 文件」的引用关系。
            String fileId = publishCheckpoint(store, "305", "搬家前的检查点正文");
            try (Statement statement = connection.createStatement()) {
                statement.execute("INSERT INTO execution VALUES (305, '" + fileId + "')");
            }
            // 关键：保持连接打开、不关库，让最近的提交只存在 WAL 里（主文件里还没有）。
            sourceMainFile = Files.readAllBytes(fromDir.resolve("lingxi.sqlite"));

            new SettingsDirectoryMigrator(source, store).migrateDataDir(fromDir.toString(), toDir.toString());

            assertEquals(3, readSchemaVersion(toDir), "schema_version 必须随库快照过去");
            byte[] migratedMainFile = Files.readAllBytes(toDir.resolve("lingxi.sqlite"));
            assertFalse(java.util.Arrays.equals(sourceMainFile, migratedMainFile),
                    "迁移后的库不能只是源主文件的字节副本（否则 WAL 里的提交会丢）");
            assertTrue(java.util.Arrays.equals(Files.readAllBytes(fromDir.resolve("lingxi.sqlite")), sourceMainFile),
                    "源目录的库文件必须原样保留，搬迁失败还能退回去");

            Path copiedFile = toDir.resolve("checkpoints").resolve("305").resolve(fileId + ".json");
            assertTrue(Files.isRegularFile(copiedFile), "检查点正文必须一起搬过去");
            // 搬迁后正文在新位置就能按标识打开（新进程用新目录的存储实例读）。
            LocalFileCheckpointStore targetStore =
                    new LocalFileCheckpointStore(toDir.toString(), mapper);
            assertTrue(targetStore.read("305", fileId, String.class).contains("搬家前的检查点正文"),
                    "搬迁后的正文内容必须完好");
            String referenced = readSnapshotFile(toDir, 305L);
            assertEquals(fileId, referenced, "新库里的引用必须指向已复制过去的正文");
        }
    }

    private int readSchemaVersion(Path directory) throws Exception {
        try (Connection connection = dataSourceOf(directory).getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT version FROM schema_version")) {
            assertTrue(rows.next(), "迁移后的库里必须还有 schema_version 行");
            return rows.getInt(1);
        }
    }

    private String readSnapshotFile(Path directory, long executionId) throws Exception {
        try (Connection connection = dataSourceOf(directory).getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT snapshot_file FROM execution WHERE id = " + executionId)) {
            assertTrue(rows.next(), "迁移后的库里必须还有这条执行");
            return rows.getString(1);
        }
    }

    /** 用存储端口的写入句柄发布一份真实正文文件。 */
    private String publishCheckpoint(LocalFileCheckpointStore store, String executionId, String text) throws Exception {
        ExecutionCheckpointStore.CheckpointWriter writer = store.begin(executionId);
        try {
            mapper.writeValue(writer.stream(), text);
            writer.publish();
            return writer.fileId();
        } finally {
            writer.complete();
        }
    }

    private LocalFileCheckpointStore storeOf(Path dataDir) {
        return new LocalFileCheckpointStore(dataDir.toString(), mapper);
    }

    private static DriverManagerDataSource dataSourceOf(Path directory) {
        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName("org.sqlite.JDBC");
        // 与生产同样的形态：文件库 + WAL。
        dataSource.setUrl("jdbc:sqlite:" + directory.resolve("lingxi.sqlite").toString().replace('\\', '/')
                + "?journal_mode=WAL&synchronous=FULL&busy_timeout=5000");
        return dataSource;
    }
}


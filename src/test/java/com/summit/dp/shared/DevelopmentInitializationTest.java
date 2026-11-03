package com.summit.dp.shared;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.sqlite.JDBC;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** 开发脚本必须产出可隔离启动的 H2 副本，失败时保留来源与已有目标。 */
@EnabledOnOs(OS.WINDOWS)
class DevelopmentInitializationTest {
    @TempDir Path temporary;
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    @Timeout(180)
    void stoppedH2CopiesDataAndRewritesOnlyDevelopmentPaths() throws Exception {
        Path source = sourceHome();
        try (H2TestDatabase database = H2TestDatabase.create("development-copy")) {
            Path original = source.resolve("data/lingxi-h2.mv.db");
            Files.copy(database.databaseFile(), original);
            Path destination = temporary.resolve("development");
            assertEquals(0, initialize(source, destination, "-SqliteJdbcJar", "missing-legacy-driver.jar"));
            assertEquals(-1L, Files.mismatch(original, destination.resolve("data/lingxi-h2.mv.db")));
            assertEquals("checkpoint", Files.readString(destination.resolve("data/checkpoints/900/ck-1.json")));
            assertEquals("skill", Files.readString(destination.resolve("skill/SKILL.md")));
            JsonNode settings = mapper.readTree(destination.resolve("config/user-configs.json").toFile()).get(0);
            assertEquals(destination.resolve("data").toString(), settings.path("dataDir").asText());
            assertEquals("原有设置", settings.path("name").asText());
            assertFalse(Files.exists(destination.resolve("data/lingxi.sqlite")));
            assertNotEquals(0, initialize(source, destination));
            assertEquals(-1L, Files.mismatch(original, destination.resolve("data/lingxi-h2.mv.db")));
        }
    }

    @Test
    @Timeout(180)
    void openH2RefusesCopyWithoutPublishingDestination() throws Exception {
        Path source = sourceHome();
        try (H2TestDatabase database = H2TestDatabase.create("development-open")) {
            Path original = source.resolve("data/lingxi-h2.mv.db");
            Files.copy(database.databaseFile(), original);
            Path destination = temporary.resolve("development");
            try (InputStream held = Files.newInputStream(original)) {
                assertTrue(held.read() >= 0);
                assertNotEquals(0, initialize(source, destination));
            }
            assertFalse(Files.exists(destination));
            assertEquals(-1L, Files.mismatch(original, database.databaseFile()));
        }
    }

    @Test
    @Timeout(180)
    void legacySnapshotMigratesUsingRealCheckpointIdentifiers() throws Exception {
        Path source = sourceHome();
        String sqliteJar = Path.of(JDBC.class.getProtectionDomain().getCodeSource()
                .getLocation().toURI()).toString();
        String java = Path.of(System.getProperty("java.home"), "bin/java.exe").toString();
        assertEquals(0, run(List.of(java, "-cp", sqliteJar,
                "tools/qa/MakeSqliteFixture.java", source.resolve("data/lingxi.sqlite").toString(),
                "src/test/resources/db/legacy-sqlite/V1__schema.sql",
                "src/test/resources/db/legacy-sqlite/V2__chat_turn_reasoning_effort.sql")));
        Path small = Files.createDirectories(source.resolve("data/checkpoints/1")).resolve("ck-small.json");
        Files.writeString(small, "small-checkpoint");
        Path destination = temporary.resolve("development");
        assertEquals(0, initialize(source, destination, "-SqliteJdbcJar", sqliteJar));
        assertTrue(Files.isRegularFile(destination.resolve("data/lingxi-h2.mv.db")));
        assertFalse(Files.exists(destination.resolve("data/lingxi.sqlite")));
        assertEquals("checkpoint", Files.readString(destination.resolve("data/checkpoints/900/ck-1.json")));
        assertTrue(mapper.readTree(destination.resolve("data/migration-from-sqlite.json").toFile())
                .path("verified").asBoolean());

        // 缺少真实正文必须失败，不能靠放宽引用检查把迁移放行。
        Files.delete(small);
        Path failed = temporary.resolve("missing-checkpoint");
        assertNotEquals(0, initialize(source, failed, "-SqliteJdbcJar", sqliteJar));
        assertFalse(Files.exists(failed));
        assertTrue(Files.isRegularFile(source.resolve("data/lingxi.sqlite")));
    }

    private Path sourceHome() throws Exception {
        Path source = Files.createDirectory(temporary.resolve("source"));
        Files.createDirectories(source.resolve("data/checkpoints/900"));
        Files.writeString(source.resolve("data/checkpoints/900/ck-1.json"), "checkpoint");
        Files.createDirectories(source.resolve("config"));
        Files.createDirectories(source.resolve("skill"));
        Files.writeString(source.resolve("skill/SKILL.md"), "skill");
        mapper.writeValue(source.resolve("config/user-configs.json").toFile(), List.of(Map.of(
                "id", 1, "name", "原有设置", "dataDir", source.resolve("data").toString(),
                "skillDir", source.resolve("skill").toString())));
        return source;
    }

    private int initialize(Path source, Path destination, String... options) throws Exception {
        List<String> command = new ArrayList<>(List.of("powershell.exe", "-NoProfile", "-ExecutionPolicy",
                "Bypass", "-File", "scripts/Initialize-Development.ps1", "-SourceHome", source.toString(),
                "-Destination", destination.toString()));
        command.addAll(List.of(options));
        return run(command);
    }

    private int run(List<String> command) throws Exception {
        Path log = Files.createTempFile(temporary, "process-", ".log");
        Process process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        if (!process.waitFor(150, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            fail("开发初始化进程超时: " + log);
        }
        if (process.exitValue() != 0) System.out.println(new String(Files.readAllBytes(log), StandardCharsets.UTF_8));
        return process.exitValue();
    }
}

package com.summit.dp.shared;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestPaths;
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
    /** 最近一次子进程（powershell / java）的输出，失败时拼进断言消息。 */
    private String lastProcessLog = "";

    @Test
    @Timeout(180)
    void stoppedH2CopiesDataAndRewritesOnlyDevelopmentPaths() throws Exception {
        Path source = sourceHome();
        try (H2TestDatabase database = H2TestDatabase.create("development-copy")) {
            Path original = source.resolve("data/lingxi-h2.mv.db");
            Files.copy(database.databaseFile(), original);
            Path destination = temporary.resolve("development");
            int copied = initialize(source, destination, "-SqliteJdbcJar", "missing-legacy-driver.jar");
            assertEquals(0, copied, "开发副本复制失败；子进程输出：\n" + lastProcessLog);
            assertEquals(-1L, Files.mismatch(original, destination.resolve("data/lingxi-h2.mv.db")));
            assertEquals("checkpoint", Files.readString(destination.resolve("data/checkpoints/900/ck-1.json")));
            assertEquals("skill", Files.readString(destination.resolve("skill/SKILL.md")));
            JsonNode settings = mapper.readTree(destination.resolve("config/user-configs.json").toFile()).get(0);
            // 路径比较一律走 Path 口径（见 TestPaths）：CI 的临时目录是 8.3 短名
            // （C:\Users\RUNNER~1\...），业务侧写进 user-configs.json 的是长名
            // （C:\Users\runneradmin\...）。逐字符比字符串必红，但配置其实是对的。
            TestPaths.assertSamePath(destination.resolve("data"), Path.of(settings.path("dataDir").asText()),
                    "user-configs.json 的 dataDir 必须指向开发副本的 data 目录");
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
        String java = javaExecutable().toString();
        // 把子进程输出带进断言消息：CI 上这条红过一次，而 surefire 默认不保留 System.out，
        // 只剩一句 "expected: <0> but was: <1>"，根本没法定位（是 java 启动失败、夹具编译失败，
        // 还是参数不对）。诊断信息必须跟着断言走。
        int fixture = run(List.of(java, "-cp", sqliteJar,
                "tools/qa/MakeSqliteFixture.java", source.resolve("data/lingxi.sqlite").toString(),
                "src/test/resources/db/legacy-sqlite/V1__schema.sql",
                "src/test/resources/db/legacy-sqlite/V2__chat_turn_reasoning_effort.sql"));
        assertEquals(0, fixture, "SQLite 夹具生成失败（java=" + java + "）；子进程输出：\n" + lastProcessLog);
        Path small = Files.createDirectories(source.resolve("data/checkpoints/1")).resolve("ck-small.json");
        Files.writeString(small, "small-checkpoint");
        Path destination = temporary.resolve("development");
        int migrated = initialize(source, destination, "-SqliteJdbcJar", sqliteJar);
        assertEquals(0, migrated, "旧库迁移到开发副本失败；子进程输出：\n" + lastProcessLog);
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

    /**
     * 当前 JVM 对应的 java 可执行文件。
     *
     * <p><b>为什么不能写死 {@code bin/java.exe}：</b>那是 Windows 布局；同一份代码在 Unix
     * 布局（{@code bin/java}）下拿不到可执行文件，ProcessBuilder 直接抛 IOException 或跑出非 0。</p>
     *
     * <p><b>为什么不用 {@code os.name} 猜平台：</b>字符串猜是同一类缺陷的源头（各种
     * "Windows 10"/"Windows Server 2022"/本地化版本号都会让判断失效）。这里用<b>文件是否存在</b>
     * 判定：两种布局各探一次，命中即用；都不命中时退回 JVM 自己的镜像路径
     * （{@code ProcessHandle.current().info().command()}，由 JVM 从进程环境取，不依赖 PATH）。</p>
     *
     * @return 可执行的 java 路径
     */
    private static Path javaExecutable() {
        Path bin = Path.of(System.getProperty("java.home"), "bin");
        for (String name : List.of("java", "java.exe")) {
            Path candidate = bin.resolve(name);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return ProcessHandle.current().info().command()
                .map(Path::of)
                .orElseThrow(() -> new AssertionError("找不到 java 可执行文件，已尝试: " + bin.resolve("java")
                        + " 与 " + bin.resolve("java.exe")));
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
        // 子进程输出一律留存：失败时进断言消息，成功时清空（避免把上一次的输出带到下一条断言）。
        lastProcessLog = new String(Files.readAllBytes(log), StandardCharsets.UTF_8);
        if (process.exitValue() != 0) System.out.println(lastProcessLog);
        return process.exitValue();
    }
}

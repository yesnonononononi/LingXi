package com.summit.dp.shared;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 静态检查：生产代码只走 {@code DataSource}，禁止直接 {@code DriverManager}（设计 §附录D.2 的 M16）。
 *
 * <p><b>为什么必须用静态检查而不是行为断言</b>：{@code DriverManager.getConnection} 在功能上「也能跑通」，
 * 但它绕开了连接池、时区初始化语句（{@code SET TIME ZONE 'UTC'}）与事务集成 —— 在双引擎并存之后，
 * 这种绕行会制造「同一个应用里两套连接参数」的静默偏差。因此把它做成扫到即红的守卫。</p>
 */
class StorageDriverPolicyTest {

    @TempDir
    Path temporary;

    private static final List<String> FORBIDDEN_RUNTIME_TOKENS = List.of(
            "org.sqlite", "jdbc:sqlite:", "SqliteSchemaInitializer", "SqliteExceptionTranslator",
            "StorageEngineProperties", "DbType.SQLITE", "handler.sqlite", "lingxi.storage.engine",
            "VACUUM INTO", "ChecklistWriteMonitor", "READ_SNAPSHOTS");

    @Test
    void runtimeScannerDetectsNestedFilesIncludingNulBytes() throws IOException {
        Path nested = Files.createDirectories(temporary.resolve("nested/deeper"));
        Files.writeString(nested.resolve("Canary.java"), "\0org.sqlite.JDBC", StandardCharsets.UTF_8);
        assertTrue(!findRuntimeViolations(temporary).isEmpty(), "扫描器必须递归并命中含 NUL 的正样本");
    }

    @Test
    void productionContainsNoSqliteRuntimeOrEngineSwitch() throws IOException {
        Path sources = locateMainSources().getParent();
        List<String> violations = findRuntimeViolations(sources);
        assertTrue(violations.isEmpty(), "运行期只能使用 H2，命中=" + violations);
    }

    @Test
    void sqliteDriverStaysTestScoped() throws IOException {
        String pom = Files.readString(locateMainSources().getParent().getParent().getParent().resolve("pom.xml"));
        String dependency = pom.substring(pom.indexOf("<artifactId>sqlite-jdbc</artifactId>"));
        dependency = dependency.substring(0, dependency.indexOf("</dependency>"));
        assertTrue(dependency.contains("<scope>test</scope>"), "SQLite 驱动不得进入运行包");
    }

    private static List<String> findRuntimeViolations(Path root) throws IOException {
        assertTrue(Files.isDirectory(root), "扫描根目录必须存在: " + root);
        List<String> violations = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                String name = file.getFileName().toString();
                if (!name.matches(".*\\.(java|yaml|yml|sql|json|factories)$")) continue;
                String body = Files.readString(file, StandardCharsets.UTF_8);
                if (name.endsWith(".java")) {
                    body = body.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)^\\s*//.*$", "");
                }
                for (String token : FORBIDDEN_RUNTIME_TOKENS) {
                    if (body.contains(token)) violations.add(root.relativize(file) + ": " + token);
                }
            }
        }
        return violations;
    }

    @Test
    @DisplayName("src/main 下 DriverManager 引用数为 0（只允许走 DataSource）")
    void productionCodeNeverUsesDriverManager() throws IOException {
        assertTrue("\0DriverManager".contains("DriverManager"), "扫描器必须命中含 NUL 的正样本");
        Path root = locateMainSources();
        List<String> offenders = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String body = Files.readString(file, StandardCharsets.UTF_8);
                if (body.contains("DriverManager")) {
                    offenders.add(root.relativize(file).toString().replace('\\', '/'));
                }
            }
        }
        assertTrue(offenders.isEmpty(),
                "生产代码禁止直接使用 DriverManager（会绕开连接池与时区初始化），命中=" + offenders);
    }

    /** 从 user.dir 逐级向上找 {@code src/main/java}。 */
    private static Path locateMainSources() {
        Path dir = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        for (int hops = 0; hops < 4 && dir != null; hops++, dir = dir.getParent()) {
            Path candidate = dir.resolve("src/main/java");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        return Paths.get("src/main/java").toAbsolutePath();
    }
}

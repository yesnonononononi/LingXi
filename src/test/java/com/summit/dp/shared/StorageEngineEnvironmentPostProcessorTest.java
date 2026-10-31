package com.summit.dp.shared;

import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineEnvironmentPostProcessor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 环境期覆写的确定性断言（设计 §1.3 的「引擎 × 环境期副作用」格子）。
 *
 * <p><b>为什么必须在环境期断言而不是启动整个应用</b>：连接池一旦建起来，URL/驱动就定死了，
 * 能否覆写只有在「环境刚就绪、Bean 还没建」这一刻可判。本用例直接调用后处理器，
 * 对「sqlite 分支零写入」「h2 分支写全 URL/驱动/UTC」逐键断言 —— 这正是「不设开关时行为逐字不变」
 * 与「设了 h2 就一定连 H2」这两条硬约束的机器化检查。</p>
 */
class StorageEngineEnvironmentPostProcessorTest {

    /** yaml 里 SQLite 的驱动；sqlite 分支必须让它原样存活。 */
    private static final String SQLITE_DRIVER = "org.sqlite.JDBC";

    private final StorageEngineEnvironmentPostProcessor processor =
            new StorageEngineEnvironmentPostProcessor();
    private final List<Path> createdDirectories = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (Path directory : createdDirectories) {
            deleteQuietly(directory);
        }
        createdDirectories.clear();
    }

    @Test
    @DisplayName("排序：数据目录后处理器（LOWEST_PRECEDENCE-100）必须先于引擎后处理器（LOWEST_PRECEDENCE）")
    void orderIsAfterDataDirResolution() {
        int engineOrder = processor.getOrder();
        assertEquals(Integer.MAX_VALUE, engineOrder, "引擎后处理器必须排在最后");
        assertTrue(engineOrder > Integer.MAX_VALUE - 100,
                "引擎后处理器必须晚于解析数据目录的那个（否则会拿错目录判形态）");
    }

    @Test
    @DisplayName("缺省（不写开关）= sqlite：URL/驱动一字不改，只把类型处理器包收窄到 sqlite")
    void defaultKeepsSqliteDataSourceUntouched() throws IOException {
        Path dataDir = newDataDir("engine-default");
        MockEnvironment environment = environment(dataDir, null);
        environment.setProperty("spring.datasource.url",
                "jdbc:sqlite:" + dataDir.toString().replace('\\', '/') + "/lingxi.sqlite");
        environment.setProperty("spring.datasource.driver-class-name", SQLITE_DRIVER);

        processor.postProcessEnvironment(environment, new SpringApplication());

        String url = environment.getProperty("spring.datasource.url");
        assertNotNull(url, "sqlite 分支必须保留 yaml 里的 URL");
        assertTrue(url.startsWith("jdbc:sqlite:"), "sqlite 分支不得改写 URL，实际=" + url);
        assertTrue(url.endsWith("/lingxi.sqlite"), "sqlite 分支的库文件仍是 lingxi.sqlite，实际=" + url);
        assertTrue(!url.contains("INIT=") && !url.contains("FILE_LOCK"),
                "sqlite 分支不得混入 H2 专用 URL 参数，实际=" + url);
        assertEquals(SQLITE_DRIVER, environment.getProperty("spring.datasource.driver-class-name"),
                "sqlite 分支不得改写驱动");
        assertNull(environment.getProperty("spring.datasource.druid.connection-init-sqls"),
                "sqlite 分支不得写入 H2 专用池参数");
        assertEquals(StorageEngine.SQLITE.typeHandlerPackage(),
                environment.getProperty("mybatis-plus.type-handlers-package"),
                "类型处理器包必须收窄到 sqlite 分支");
    }

    @Test
    @DisplayName("engine=h2：URL/驱动/池参数/UTC 会话一次写全，类型处理器包切到 h2")
    void h2OverridesEveryDataSourceKey() throws IOException {
        Path dataDir = newDataDir("engine-h2");
        MockEnvironment environment = environment(dataDir, "h2");

        processor.postProcessEnvironment(environment, new SpringApplication());

        String url = environment.getProperty("spring.datasource.url");
        assertNotNull(url, "h2 分支必须覆写 URL");
        assertTrue(url.startsWith("jdbc:h2:file:"), "URL 必须是 H2 文件库，实际=" + url);
        assertTrue(url.contains("INIT=SET TIME ZONE 'UTC'"), "URL 必须把会话时区锁成 UTC，实际=" + url);
        assertTrue(url.contains("TRACE_LEVEL_FILE=0"), "URL 必须关掉 .trace.db 落盘，实际=" + url);
        assertTrue(url.contains("AUTO_SERVER=FALSE"), "URL 不得开启自动混合模式，实际=" + url);
        assertEquals("org.h2.Driver", environment.getProperty("spring.datasource.driver-class-name"),
                "驱动必须切成 H2");
        assertEquals("SET TIME ZONE 'UTC'",
                environment.getProperty("spring.datasource.druid.connection-init-sqls"),
                "连接池层面也要显式声明 UTC（与 URL 幂等）");
        assertEquals("SELECT 1", environment.getProperty("spring.datasource.druid.validation-query"));
        assertEquals(StorageEngine.H2.typeHandlerPackage(),
                environment.getProperty("mybatis-plus.type-handlers-package"),
                "类型处理器包必须切到 h2 分支");
    }

    @Test
    @DisplayName("engine=h2 但目录里只有 SQLite 数据：启动前拒绝，且不创建任何 H2 库文件")
    void h2WithSqliteDataIsRejectedBeforeAnyFileIsCreated() throws IOException {
        Path dataDir = newDataDir("engine-reject");
        Files.writeString(dataDir.resolve("lingxi.sqlite"), "SQLite format 3\u0000placeholder",
                StandardCharsets.UTF_8);
        MockEnvironment environment = environment(dataDir, "h2");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> processor.postProcessEnvironment(environment, new SpringApplication()));
        assertTrue(failure.getMessage().contains("Migrate-SqliteToH2"),
                "提示必须给出可执行建议，实际=" + failure.getMessage());
        assertTrue(!Files.exists(dataDir.resolve("lingxi-h2.mv.db")),
                "拒绝启动时绝不能创建 H2 库文件");
    }

    @Test
    @DisplayName("引擎取值非法：启动前抛错并列出允许值（不静默回落 sqlite）")
    void illegalEngineValueFailsFast() throws IOException {
        Path dataDir = newDataDir("engine-illegal");
        MockEnvironment environment = environment(dataDir, "postgres");

        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> processor.postProcessEnvironment(environment, new SpringApplication()));
        assertTrue(failure.getMessage().contains("sqlite") && failure.getMessage().contains("h2"),
                "错误消息必须列出允许值，实际=" + failure.getMessage());
    }

    /** 最小可用环境：数据目录 + 引擎（可为 null 表示不写开关）。 */
    private MockEnvironment environment(Path dataDir, String engine) {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("lingxi.data.dir", dataDir.toString().replace('\\', '/'));
        if (engine != null) {
            environment.setProperty(StorageEngineEnvironmentPostProcessor.ENGINE_KEY, engine);
        }
        return environment;
    }

    private Path newDataDir(String prefix) throws IOException {
        Path root = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-h2-verify");
        Files.createDirectories(root);
        Path directory = Files.createTempDirectory(root, "post-" + prefix + "-");
        createdDirectories.add(directory);
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
                    // 清理失败不掩盖断言结果
                }
            });
        } catch (IOException ignored) {
            // 同上
        }
    }
}

package com.summit.dp.shared;

import com.alibaba.druid.pool.DruidDataSource;
import com.summit.dp.shared.config.H2MaintenanceConfig;
import com.summit.dp.shared.storage.H2ShutdownCompactor;
import com.summit.dp.shared.storage.StorageDataSourceKeys;
import com.summit.dp.shared.storage.StorageLayout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.MapPropertySource;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class H2ShutdownCompactorTest {

    @TempDir
    Path tempDir;

    @Test
    void compactsBloatedDatabaseOnlyWhenEnabledAndThresholdsMet() throws Exception {
        StorageLayout layout = new StorageLayout(tempDir);
        createBloatedDatabase(layout);

        long bloatedSize = Files.size(layout.databaseFile());
        assertTrue(bloatedSize > 1024L * 1024L, "预期测试库先产生明显膨胀: " + bloatedSize);

        H2ShutdownCompactor disabled = new H2ShutdownCompactor(layout, "", "", false, 1, 80);
        assertFalse(disabled.compactIfNeeded());

        H2ShutdownCompactor highSizeThreshold = new H2ShutdownCompactor(layout, "", "", true, 1024, 80);
        assertFalse(highSizeThreshold.compactIfNeeded());

        H2ShutdownCompactor strictFillThreshold = new H2ShutdownCompactor(layout, "", "", true, 1, 0);
        assertFalse(strictFillThreshold.compactIfNeeded());

        H2ShutdownCompactor active = new H2ShutdownCompactor(layout, "", "", true, 1, 80);
        assertTrue(active.compactIfNeeded());

        long compactedSize = Files.size(layout.databaseFile());
        assertTrue(compactedSize < bloatedSize / 2,
                "压缩后应明显瘦身: before=" + bloatedSize + ", after=" + compactedSize);

        try (Connection conn = DriverManager.getConnection(StorageDataSourceKeys.h2Url(layout), "", "");
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT LENGTH(payload) FROM compact_probe WHERE id = 1")) {
            assertTrue(rs.next());
            assertEquals(512 * 1024, rs.getInt(1));
        }
    }

    @Test
    void springShutdownClosesDruidDataSourceBeforeCompactorRuns() throws Exception {
        StorageLayout layout = new StorageLayout(tempDir);
        createBloatedDatabase(layout);
        long bloatedSize = Files.size(layout.databaseFile());

        AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
        context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
                "lingxi.data.dir", tempDir.toString(),
                "lingxi.storage.h2-compact-on-shutdown.enabled", "true",
                "lingxi.storage.h2-compact-on-shutdown.min-file-size-mb", "1",
                "lingxi.storage.h2-compact-on-shutdown.max-fill-rate-percent", "80")));
        context.register(TestDataSourceConfig.class, H2MaintenanceConfig.class);
        context.refresh();

        // 持有一次活跃查询以确保 DruidDataSource 已真实建立并锁定 H2 文件。
        DataSource dataSource = context.getBean(DataSource.class);
        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM compact_probe")) {
            assertTrue(rs.next());
            assertEquals(1, rs.getInt(1));
        }

        context.close();

        long afterShutdownSize = Files.size(layout.databaseFile());
        assertTrue(afterShutdownSize < bloatedSize / 2,
                "容器关闭应先释放 DruidDataSource 文件锁再完成压缩: before="
                        + bloatedSize + ", after=" + afterShutdownSize);
    }

    private static void createBloatedDatabase(StorageLayout layout) throws Exception {
        String url = StorageDataSourceKeys.h2Url(layout);
        StringBuilder sb = new StringBuilder(512 * 1024);
        for (int i = 0; i < 512 * 1024; i++) {
            sb.append((char) ('a' + ((i * 31 + i / 7) % 26)));
        }
        String basePayload = sb.toString();
        try (Connection conn = DriverManager.getConnection(url, "", "");
             Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE compact_probe (id INT PRIMARY KEY, payload CLOB)");
            st.execute("MERGE INTO compact_probe (id, payload) VALUES (1, 'init')");
            st.execute("CHECKPOINT");
            // 用第二个未提交连接钉住旧版本号，真实模拟线上死 chunk 无法回收的膨胀过程。
            try (Connection holder = DriverManager.getConnection(url, "", "")) {
                holder.setAutoCommit(false);
                try (Statement hst = holder.createStatement();
                     ResultSet hrs = hst.executeQuery("SELECT COUNT(*) FROM compact_probe")) {
                    hrs.next();
                }
                try (PreparedStatement ps = conn.prepareStatement("MERGE INTO compact_probe (id, payload) VALUES (1, ?)")) {
                    for (int i = 0; i < 8; i++) {
                        ps.setString(1, (char) ('A' + i) + basePayload.substring(1));
                        ps.executeUpdate();
                        st.execute("CHECKPOINT");
                    }
                }
                holder.rollback();
            }
            st.execute("SHUTDOWN");
        }
    }

    @Configuration
    static class TestDataSourceConfig {
        @Bean(destroyMethod = "close")
        public DruidDataSource dataSource(Environment env) {
            StorageLayout layout = new StorageLayout(Path.of(env.getRequiredProperty("lingxi.data.dir")));
            DruidDataSource ds = new DruidDataSource();
            ds.setUrl(StorageDataSourceKeys.h2Url(layout));
            ds.setDriverClassName("org.h2.Driver");
            ds.setValidationQuery("SELECT 1");
            ds.setInitialSize(1);
            ds.setMinIdle(1);
            ds.setMaxActive(2);
            return ds;
        }
    }
}

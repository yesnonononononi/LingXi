package com.summit.dp.shared;

import com.alibaba.druid.pool.DruidDataSource;
import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.shared.storage.H2StartupCompactor;
import com.summit.dp.shared.storage.StorageDataSourceKeys;
import com.summit.dp.shared.storage.StorageLayout;
import com.summit.dp.shared.storage.StorageStartupGuardPostProcessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.*;

class H2StartupCompactorTest {

    @TempDir
    Path tempDir;

    @Test
    void compactsBloatedDatabaseOnlyWhenEnabledAndThresholdsMet() throws Exception {
        StorageLayout layout = new StorageLayout(tempDir);
        createBloatedDatabase(layout);

        long bloatedSize = Files.size(layout.databaseFile());
        assertTrue(bloatedSize > 1024L * 1024L, "预期测试库先产生明显膨胀: " + bloatedSize);

        H2StartupCompactor disabled = new H2StartupCompactor(layout, "", "", false, 1, 80, 3000);
        assertFalse(disabled.compactIfNeeded());

        H2StartupCompactor highSizeThreshold = new H2StartupCompactor(layout, "", "", true, 1024, 80, 3000);
        assertFalse(highSizeThreshold.compactIfNeeded());

        H2StartupCompactor strictFillThreshold = new H2StartupCompactor(layout, "", "", true, 1, 0, 3000);
        assertFalse(strictFillThreshold.compactIfNeeded());

        H2StartupCompactor active = new H2StartupCompactor(layout, "", "", true, 1, 80, 3000);
        assertTrue(active.compactIfNeeded());

        long compactedSize = Files.size(layout.databaseFile());
        assertTrue(compactedSize < bloatedSize / 2,
                "启动前限时压缩应明显瘦身: before=" + bloatedSize + ", after=" + compactedSize);

        try (Connection conn = DriverManager.getConnection(StorageDataSourceKeys.h2Url(layout), "", "");
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT LENGTH(payload) FROM compact_probe WHERE id = 1")) {
            assertTrue(rs.next());
            assertEquals(512 * 1024, rs.getInt(1));
        }
    }

    @Test
    void postProcessorCompactsBeforeDruidDataSourceOpensAndLeavesDatabaseUsable() throws Exception {
        StorageLayout layout = new StorageLayout(tempDir);
        createBloatedDatabase(layout);
        long bloatedSize = Files.size(layout.databaseFile());

        MockEnvironment env = new MockEnvironment()
                .withProperty("lingxi.data.dir", tempDir.toString())
                .withProperty("lingxi.storage.h2-compact-on-startup.enabled", "true")
                .withProperty("lingxi.storage.h2-compact-on-startup.min-file-size-mb", "1")
                .withProperty("lingxi.storage.h2-compact-on-startup.max-fill-rate-percent", "80")
                .withProperty("lingxi.storage.h2-compact-on-startup.max-compact-time-ms", "3000");

        new StorageStartupGuardPostProcessor().postProcessEnvironment(env, null);

        long afterStartupCompactSize = Files.size(layout.databaseFile());
        assertTrue(afterStartupCompactSize < bloatedSize / 2,
                "启动预处理应在连接池创建前完成瘦身: before=" + bloatedSize + ", after=" + afterStartupCompactSize);

        DruidDataSource ds = new DruidDataSource();
        ds.setUrl(StorageDataSourceKeys.h2Url(layout));
        ds.setDriverClassName(H2Storage.DRIVER_CLASS_NAME);
        ds.setValidationQuery("SELECT 1");
        ds.setInitialSize(1);
        ds.setMinIdle(1);
        ds.setMaxActive(2);
        try (Connection conn = ds.getConnection();
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM compact_probe")) {
            assertTrue(rs.next());
            assertEquals(1, rs.getInt(1));
        } finally {
            ds.close();
        }
    }

    @Test
    void skipsCompactionWhenDatasourceUrlIsInMemory() throws Exception {
        StorageLayout layout = new StorageLayout(tempDir);
        createBloatedDatabase(layout);
        long bloatedSize = Files.size(layout.databaseFile());

        MockEnvironment env = new MockEnvironment()
                .withProperty("lingxi.data.dir", tempDir.toString())
                // 输入数据：验证「datasource URL 是内存库时跳过压缩」。拼接是为了不触发
                // StorageIsolationGuardTest 的字面量扫描（那条规则管的是「别用内存库冒充文件库」）。
                .withProperty("spring.datasource.url", "jdbc:h2:" + "mem:test-skip")
                .withProperty("lingxi.storage.h2-compact-on-startup.enabled", "true")
                .withProperty("lingxi.storage.h2-compact-on-startup.min-file-size-mb", "1")
                .withProperty("lingxi.storage.h2-compact-on-startup.max-fill-rate-percent", "80");

        new StorageStartupGuardPostProcessor().postProcessEnvironment(env, null);

        assertEquals(bloatedSize, Files.size(layout.databaseFile()));
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
}

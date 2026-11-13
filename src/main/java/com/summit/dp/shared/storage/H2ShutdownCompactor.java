package com.summit.dp.shared.storage;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.DisposableBean;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 停机后按需压缩 H2 数据库文件，回收因 MVStore 死块或未截断尾部导致的体积膨胀。
 *
 * <p>必须通过 {@code dataSource} 的 {@code dependsOn} 约束在数据源关闭之后销毁，
 * 避免与尚未停止的业务线程或连接池竞争文件锁。</p>
 */
@Slf4j
public class H2ShutdownCompactor implements DisposableBean {

    private static final long BYTES_PER_MB = 1024L * 1024L;

    private final StorageLayout layout;
    private final String username;
    private final String password;
    private final boolean enabled;
    private final long minFileSizeBytes;
    private final int maxFillRatePercent;

    public H2ShutdownCompactor(
            StorageLayout layout,
            String username,
            String password,
            boolean enabled,
            long minFileSizeMb,
            int maxFillRatePercent) {
        this.layout = layout;
        this.username = username == null ? "" : username;
        this.password = password == null ? "" : password;
        this.enabled = enabled;
        this.minFileSizeBytes = Math.max(0L, minFileSizeMb) * BYTES_PER_MB;
        this.maxFillRatePercent = maxFillRatePercent;
    }

    @Override
    public void destroy() {
        compactIfNeeded();
    }

    /** 满足开关、体积下限与填充率阈值时执行一次 {@code SHUTDOWN COMPACT}；任何异常均记录后放行退出。 */
    public boolean compactIfNeeded() {
        if (!enabled) {
            return false;
        }
        Path dbFile = layout.databaseFile();
        if (!Files.isRegularFile(dbFile)) {
            return false;
        }
        long beforeBytes = readFileSize(dbFile);
        if (beforeBytes < minFileSizeBytes) {
            return false;
        }
        String base = jdbcBasePath(layout);
        try {
            Map<String, Long> metrics = readChunkMetrics(base);
            long fillRate = metrics.getOrDefault("info.CHUNKS_FILL_RATE", 100L);
            long chunkCount = metrics.getOrDefault("info.CHUNK_COUNT", 0L);
            if (fillRate > maxFillRatePercent) {
                log.info("跳过 H2 停机压缩: sizeMB={}, fillRate={}%, chunkCount={}",
                        toMb(beforeBytes), fillRate, chunkCount);
                return false;
            }
            long startMs = System.currentTimeMillis();
            executeShutdownCompact(base);
            long elapsedMs = System.currentTimeMillis() - startMs;
            long afterBytes = readFileSize(dbFile);
            log.info("完成 H2 停机压缩: beforeMB={}, afterMB={}, fillRate={}%, chunkCount={}, costMs={}",
                    toMb(beforeBytes), toMb(afterBytes), fillRate, chunkCount, elapsedMs);
            return true;
        } catch (Exception failure) {
            log.warn("H2 停机压缩失败，已跳过: database={}, reason={}", dbFile, failure.getMessage());
            return false;
        }
    }

    private Map<String, Long> readChunkMetrics(String base) throws SQLException {
        String readOnlyUrl = "jdbc:h2:file:" + base + ";ACCESS_MODE_DATA=r;IFEXISTS=TRUE";
        Map<String, Long> metrics = new LinkedHashMap<>();
        try (Connection conn = DriverManager.getConnection(readOnlyUrl, username, password);
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT SETTING_NAME, SETTING_VALUE FROM INFORMATION_SCHEMA.SETTINGS "
                             + "WHERE SETTING_NAME IN ('info.CHUNKS_FILL_RATE', 'info.CHUNK_COUNT')")) {
            while (rs.next()) {
                String name = rs.getString(1);
                String value = rs.getString(2);
                if (value != null) {
                    metrics.put(name, Long.parseLong(value.trim()));
                }
            }
        }
        return metrics;
    }

    private void executeShutdownCompact(String base) throws SQLException {
        String compactUrl = "jdbc:h2:file:" + base + ";IFEXISTS=TRUE";
        try (Connection conn = DriverManager.getConnection(compactUrl, username, password);
             Statement st = conn.createStatement()) {
            st.execute("SHUTDOWN COMPACT");
        }
    }

    private static String jdbcBasePath(StorageLayout layout) {
        return layout.dataDir().resolve(H2Storage.JDBC_DATABASE_NAME).toString().replace('\\', '/');
    }

    private static long readFileSize(Path path) {
        try {
            return Files.size(path);
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private static long toMb(long bytes) {
        return bytes / BYTES_PER_MB;
    }
}

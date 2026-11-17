package com.summit.dp.shared.storage;

import lombok.extern.slf4j.Slf4j;

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
 * 启动前按需压缩 H2 数据库文件，在限定时间窗口内回收 MVStore 死块造成的体积膨胀。
 *
 * <p>必须在连接池创建之前执行，且受 {@code MAX_COMPACT_TIME} 限制，避免大库启动长时间卡顿。</p>
 */
@Slf4j
public class H2StartupCompactor {

    private static final long BYTES_PER_MB = 1024L * 1024L;
    private static final int MIN_COMPACT_TIME_MS = 100;

    private final StorageLayout layout;
    private final String username;
    private final String password;
    private final boolean enabled;
    private final long minFileSizeBytes;
    private final int maxFillRatePercent;
    private final int maxCompactTimeMs;

    public H2StartupCompactor(
            StorageLayout layout,
            String username,
            String password,
            boolean enabled,
            long minFileSizeMb,
            int maxFillRatePercent,
            int maxCompactTimeMs) {
        this.layout = layout;
        this.username = username == null ? "" : username;
        this.password = password == null ? "" : password;
        this.enabled = enabled;
        this.minFileSizeBytes = Math.max(0L, minFileSizeMb) * BYTES_PER_MB;
        this.maxFillRatePercent = maxFillRatePercent;
        this.maxCompactTimeMs = Math.max(MIN_COMPACT_TIME_MS, maxCompactTimeMs);
    }

    /** 满足开关、体积下限与填充率阈值时执行限时压缩；任何异常均记录后放行启动。 */
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
                log.info("跳过 H2 启动前压缩: sizeMB={}, fillRate={}%, chunkCount={}",
                        toMb(beforeBytes), fillRate, chunkCount);
                return false;
            }
            long startMs = System.currentTimeMillis();
            executeBoundedCompact(base);
            long elapsedMs = System.currentTimeMillis() - startMs;
            long afterBytes = readFileSize(dbFile);
            log.info("完成 H2 启动前压缩: beforeMB={}, afterMB={}, fillRate={}%, chunkCount={}, maxCompactTimeMs={}, costMs={}",
                    toMb(beforeBytes), toMb(afterBytes), fillRate, chunkCount, maxCompactTimeMs, elapsedMs);
            return true;
        } catch (Exception failure) {
            log.warn("H2 启动前压缩失败，已跳过: database={}, reason={}", dbFile, failure.getMessage());
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

    private void executeBoundedCompact(String base) throws SQLException {
        // 用普通 SHUTDOWN 配合 MAX_COMPACT_TIME，避免 SHUTDOWN COMPACT 无上限耗时阻塞启动。
        String compactUrl = "jdbc:h2:file:" + base + ";IFEXISTS=TRUE;MAX_COMPACT_TIME=" + maxCompactTimeMs;
        try (Connection conn = DriverManager.getConnection(compactUrl, username, password);
             Statement st = conn.createStatement()) {
            st.execute("SHUTDOWN");
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

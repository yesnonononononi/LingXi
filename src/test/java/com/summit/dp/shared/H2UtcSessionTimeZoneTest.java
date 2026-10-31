package com.summit.dp.shared;

import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * H2 连接必须锁在 UTC 会话时区（设计 §附录D.2 的 M6，以及「时间是 UTC 瞬时」共享约定）。
 *
 * <p><b>为什么这条用例必须有</b>：类型处理器读写 {@code TIMESTAMP(3)} 时显式带 UTC
 * {@code Calendar}，所以「显式写、显式读」的往返在会话时区为 +08 时也照样相等 ——
 * 光靠往返用例发现不了少掉 {@code SET TIME ZONE 'UTC'}。真正的破口在
 * <b>库侧自己产生的时间</b>：{@code DEFAULT CURRENT_TIMESTAMP} 与
 * {@code ON UPDATE CURRENT_TIMESTAMP}，它们按<b>会话时区</b>取值。会话时区不是 UTC，
 * 这些列就会写进本地墙钟（+08），而读侧按 UTC 解释 → 所有自动时间列整体偏移 8 小时。</p>
 *
 * <p>因此这里直接断言两件事：① 会话时区偏移为 0；② 依赖库默认值插入的时间列等于 UTC 现在。</p>
 */
class H2UtcSessionTimeZoneTest {

    private static final DateTimeFormatter TIMESTAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss[.SSS]");

    private final List<H2TestDatabase> databases = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (H2TestDatabase database : databases) {
            database.shutdown();
        }
        databases.clear();
    }

    @Test
    @DisplayName("H2 会话时区偏移必须是 0 小时（SET TIME ZONE 'UTC' 真的生效）")
    void sessionTimeZoneIsUtc() {
        H2TestDatabase database = newDatabase("tz-offset");
        String offset = database.queryString(
                "SELECT CAST(EXTRACT(TIMEZONE_HOUR FROM CURRENT_TIMESTAMP) AS VARCHAR)");
        assertEquals("0", offset,
                "H2 会话时区必须是 +00：默认取 JVM 本地时区，一旦漏掉 SET TIME ZONE 'UTC'，"
                        + "DEFAULT/ON UPDATE CURRENT_TIMESTAMP 就会写本地墙钟（实测 +08）");
    }

    @Test
    @DisplayName("库侧默认时间列写的是 UTC 墙钟：create_time 与 UTC 现在相差不超过 5 分钟")
    void databaseGeneratedTimestampsAreUtc() {
        H2TestDatabase database = newDatabase("tz-default");
        database.execute("INSERT INTO session (name) VALUES ('tz-default-probe')");
        String created = database.queryString(
                "SELECT CAST(create_time AS VARCHAR) FROM session WHERE name = 'tz-default-probe'");
        assertTrue(created != null && !created.isBlank(), "默认时间列必须有值，实际=" + created);
        LocalDateTime stored = LocalDateTime.parse(created.strip().replace('T', ' '), TIMESTAMP);
        long drift = Math.abs(Duration.between(stored, LocalDateTime.now(ZoneOffset.UTC)).toMinutes());
        assertTrue(drift <= 5,
                "库侧默认时间必须是 UTC 墙钟（与时区无关），与 UTC 现在相差 " + drift
                        + " 分钟，实际值=" + created + "（差 8 小时即说明会话时区不是 UTC）");
    }

    private H2TestDatabase newDatabase(String prefix) {
        H2TestDatabase database = H2TestDatabase.create(prefix);
        databases.add(database);
        return database;
    }
}

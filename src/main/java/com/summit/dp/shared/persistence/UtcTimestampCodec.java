package com.summit.dp.shared.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Calendar;
import java.util.TimeZone;

/**
 * H2 时间列的编解码：{@code TIMESTAMP(3)} ↔ {@link Instant} / {@link LocalDateTime}，全程 UTC 口径。
 *
 * <p><b>为什么必须带 UTC {@link Calendar}</b>：JDBC 的 {@code setTimestamp/getTimestamp} 在不传
 * Calendar 时按 JVM 默认时区解释时间字面量。H2 的连接已经 {@code SET TIME ZONE 'UTC'}，
 * 但驱动做参数绑定与取值时仍会用 JVM 时区换算 —— 两者不一致就会整体偏 8 小时（本机 +08 实测）。
 * 显式传 UTC Calendar 之后，写读两端都按 UTC 解释，落在列里的就是 UTC 墙钟。</p>
 *
 * <p><b>与 SQLite 语义对齐</b>：SQLite 存 {@code yyyy-MM-dd HH:mm:ss.SSS} 的 UTC 文本（{@link TimeTextCodec}），
 * H2 存 UTC 墙钟的 {@code TIMESTAMP(3)}；{@link LocalDateTime} 一律先按 JVM 默认时区折成瞬时，
 * 读回时再折回同一时区 —— 两个引擎因此对同一个本地时间给出同一个瞬时。精度统一截断到毫秒。</p>
 */
public final class UtcTimestampCodec {

    private UtcTimestampCodec() {
    }

    /**
     * 瞬时 → 时间戳（毫秒精度）。
     *
     * @param instant 瞬时，可为 {@code null}
     * @return 毫秒截断后的 {@link Timestamp}；入参为 {@code null} 时返回 {@code null}
     */
    public static Timestamp toTimestamp(Instant instant) {
        return instant == null ? null : Timestamp.from(instant.truncatedTo(ChronoUnit.MILLIS));
    }

    /**
     * 时间戳 → 瞬时（毫秒精度）。
     *
     * @param timestamp 数据库读出的时间戳，可为 {@code null}
     * @return 毫秒截断后的 {@link Instant}；入参为 {@code null} 时返回 {@code null}
     */
    public static Instant toInstant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant().truncatedTo(ChronoUnit.MILLIS);
    }

    /**
     * 本地时间 → 时间戳：按 JVM 默认时区折算成瞬时（与 {@link TimeTextCodec#format(LocalDateTime)} 同语义）。
     *
     * @param localDateTime 本地时间，可为 {@code null}
     * @return 毫秒截断后的 {@link Timestamp}；入参为 {@code null} 时返回 {@code null}
     */
    public static Timestamp toTimestamp(LocalDateTime localDateTime) {
        if (localDateTime == null) {
            return null;
        }
        Instant instant = localDateTime.atZone(ZoneId.systemDefault()).toInstant();
        return toTimestamp(instant);
    }

    /**
     * 时间戳 → 本地时间：按 JVM 默认时区还原（与 {@link TimeTextCodec#toLocalDateTime(String)} 同语义）。
     *
     * @param timestamp 数据库读出的时间戳，可为 {@code null}
     * @return JVM 默认时区的本地时间；入参为 {@code null} 时返回 {@code null}
     */
    public static LocalDateTime toLocalDateTime(Timestamp timestamp) {
        Instant instant = toInstant(timestamp);
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
    }

    /**
     * UTC 日历：每次调用返回新实例（{@code Calendar} 非线程安全，不能共享）。
     *
     * @return 时区固定为 UTC 的日历
     */
    public static Calendar utcCalendar() {
        return Calendar.getInstance(TimeZone.getTimeZone("UTC"));
    }
}

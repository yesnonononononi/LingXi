package com.summit.dp.shared.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Calendar;
import java.util.TimeZone;

/** 时间戳绑定和取值都必须带 UTC Calendar，避免 JVM 时区导致整段偏移；本地时间按 JVM 时区往返。 */
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
     * 本地时间 → 时间戳：按 JVM 默认时区折算成瞬时。
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
     * 时间戳 → 本地时间：按 JVM 默认时区还原。
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

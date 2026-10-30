package com.summit.dp.shared.persistence;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 时间列的文本编码：SQLite 没有时间类型，全库统一存 {@code yyyy-MM-dd HH:mm:ss.SSS} 的 UTC 文本。
 *
 * <p><b>为什么不用驱动自带的日期类型</b>：sqlite-jdbc 的 {@code setTimestamp} 落的是「epoch 毫秒整数」，
 * 而它自己的 {@code getTimestamp} 又解析不了这个整数（实测 {@code Error parsing time stamp}），
 * MyBatis 内置的 Instant / LocalDateTime 处理器正好走这条路，直接不可用。</p>
 *
 * <p>统一成固定宽度的 UTC 文本后，字典序等于时间序（索引、BETWEEN、ORDER BY 都成立），
 * 也与建表脚本里 {@code strftime('%Y-%m-%d %H:%M:%f','now')} 生成的默认值同形。
 * 毫秒截断是刻意的：精度只承诺到毫秒，避免写入值与默认值精度不一致导致比较反直觉。</p>
 */
public final class TimeTextCodec {

    /** 存储格式（UTC，毫秒定宽）。 */
    private static final DateTimeFormatter FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS").withZone(ZoneOffset.UTC);

    /** 兼容 ISO 变体与历史默认值（秒级、无毫秒）。 */
    private static final Pattern TEXT_TIME = Pattern.compile(
            "(\\d{4})-(\\d{1,2})-(\\d{1,2})[ T](\\d{1,2}):(\\d{1,2}):(\\d{1,2})(?:\\.(\\d{1,9}))?");

    private TimeTextCodec() {
    }

    /** 把瞬时写成 UTC 文本。 */
    public static String format(Instant instant) {
        return instant == null ? null : FORMATTER.format(instant.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
    }

    /** 本地时间按 JVM 默认时区折算成瞬时后再写，读回时仍按同一时区还原。 */
    public static String format(LocalDateTime localDateTime) {
        return localDateTime == null ? null : format(localDateTime.atZone(ZoneId.systemDefault()).toInstant());
    }

    /** 解析文本时间；空值、无法识别的内容一律返回 null（交由字段的空语义处理，不抛给业务）。 */
    public static Instant toInstant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String value = text.trim();
        if (isAllDigits(value)) {
            // 兜住驱动或外部工具写进来的 epoch 毫秒。
            return Instant.ofEpochMilli(Long.parseLong(value));
        }
        Matcher matcher = TEXT_TIME.matcher(value);
        if (!matcher.find()) {
            return null;
        }
        String fraction = matcher.group(7);
        int nanos = fraction == null ? 0 : Integer.parseInt((fraction + "00000000").substring(0, 9));
        LocalDateTime parsed = LocalDateTime.of(
                Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(2)),
                Integer.parseInt(matcher.group(3)), Integer.parseInt(matcher.group(4)),
                Integer.parseInt(matcher.group(5)), Integer.parseInt(matcher.group(6)), nanos);
        return parsed.toInstant(ZoneOffset.UTC);
    }

    /** 把库里的 UTC 文本还原成 JVM 默认时区的本地时间。 */
    public static LocalDateTime toLocalDateTime(String text) {
        Instant instant = toInstant(text);
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
    }

    private static boolean isAllDigits(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (!Character.isDigit(value.charAt(i))) {
                return false;
            }
        }
        return !value.isEmpty();
    }
}

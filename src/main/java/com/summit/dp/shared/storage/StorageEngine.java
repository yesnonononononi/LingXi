package com.summit.dp.shared.storage;

import java.util.Locale;

/**
 * 存储引擎的唯一事实源。
 *
 * <p>驱动、库文件名、建库脚本位置、类型处理器包这四件事全部由本枚举给出，
 * 上层（环境期覆写、Bean 装配、建库、持久化适配）一律从它派生，禁止任何方言自动探测：
 * 探测会把「开关漏配」变成「静默跑错方言」，而方言错的后果是分页结果错、时间差 8 小时、
 * 唯一键冲突翻不成 {@code DuplicateKeyException} 这类沉默性故障。</p>
 *
 * <p><b>文件名与 JDBC 逻辑名是两件事</b>：SQLite 的逻辑名与文件名一致（{@code lingxi.sqlite}），
 * H2 的逻辑名是 {@code lingxi-h2}，落盘时驱动自己补 {@code .mv.db} 后缀，所以判存在性要用
 * {@link #databaseFileName()}，拼 JDBC URL 要用 {@link #jdbcDatabaseName()}。</p>
 */
public enum StorageEngine {

    /** 缺省引擎：行为与引入开关之前完全一致。 */
    SQLITE("sqlite", "lingxi.sqlite", "lingxi.sqlite", "org.sqlite.JDBC",
            "classpath*:db/sqlite/V*__*.sql",
            "com.summit.dp.shared.persistence.handler.sqlite"),

    /** 可选引擎：显式设置 {@code lingxi.storage.engine=h2} 才会生效。 */
    H2("h2", "lingxi-h2.mv.db", "lingxi-h2", "org.h2.Driver",
            "classpath*:db/h2/V*__*.sql",
            "com.summit.dp.shared.persistence.handler.h2");

    private final String id;
    private final String databaseFileName;
    private final String jdbcDatabaseName;
    private final String driverClassName;
    private final String schemaLocation;
    private final String typeHandlerPackage;

    StorageEngine(String id, String databaseFileName, String jdbcDatabaseName, String driverClassName,
                  String schemaLocation, String typeHandlerPackage) {
        this.id = id;
        this.databaseFileName = databaseFileName;
        this.jdbcDatabaseName = jdbcDatabaseName;
        this.driverClassName = driverClassName;
        this.schemaLocation = schemaLocation;
        this.typeHandlerPackage = typeHandlerPackage;
    }

    /**
     * 解析配置值。
     *
     * <p>空值与空白一律当缺省（{@link #SQLITE}）；其它无法识别的值直接抛错，
     * 让「配错了引擎名」在启动期就失败，而不是悄悄回落到 SQLite 去建一个空库。</p>
     *
     * @param raw 配置原文，可为 {@code null}
     * @return 对应引擎，绝不返回 {@code null}
     * @throws IllegalArgumentException 取值不在枚举范围内
     */
    public static StorageEngine fromProperty(String raw) {
        if (raw == null || raw.isBlank()) {
            return SQLITE;
        }
        String normalized = raw.trim().toLowerCase(Locale.ROOT);
        for (StorageEngine engine : values()) {
            if (engine.id.equals(normalized)) {
                return engine;
            }
        }
        throw new IllegalArgumentException("lingxi.storage.engine 取值非法: [" + raw.trim()
                + "]，只能是 " + SQLITE.id + " 或 " + H2.id);
    }

    /**
     * 宽松解析：非法值回落到 {@link #SQLITE}，不抛异常。
     *
     * <p>只给「必须容忍坏值、由唯一校验点统一报错」的场景用（例如数据目录后处理器的告警文案）；
     * 校验归 {@link StorageEngineGuard} 与 {@link StorageEngineEnvironmentPostProcessor}。</p>
     *
     * @param raw 配置原文，可为 {@code null}
     * @return 可识别的引擎，识别不出时返回 {@link #SQLITE}
     */
    public static StorageEngine fromPropertyOrSqlite(String raw) {
        try {
            return fromProperty(raw);
        } catch (IllegalArgumentException ignored) {
            return SQLITE;
        }
    }

    /** 配置取值（小写），也就是 {@code lingxi.storage.engine} 允许写的两个词。 */
    public String id() {
        return id;
    }

    /** 落盘文件名（H2 带 {@code .mv.db} 后缀），用于判存在性与迁移指纹。 */
    public String databaseFileName() {
        return databaseFileName;
    }

    /** JDBC URL 里的库逻辑名（H2 不带后缀，由驱动补）。 */
    public String jdbcDatabaseName() {
        return jdbcDatabaseName;
    }

    /** JDBC 驱动类名；环境期写进 {@code spring.datasource.driver-class-name}。 */
    public String driverClassName() {
        return driverClassName;
    }

    /** 建库脚本的 classpath 通配位置。 */
    public String schemaLocation() {
        return schemaLocation;
    }

    /** 本引擎专用类型处理器包（{@code Instant}/{@code LocalDateTime} 的读写方式因引擎而异）。 */
    public String typeHandlerPackage() {
        return typeHandlerPackage;
    }

    /** 是否 H2；业务与仓储层不得直接判断引擎，只有适配层用这个开关。 */
    public boolean isH2() {
        return this == H2;
    }
}

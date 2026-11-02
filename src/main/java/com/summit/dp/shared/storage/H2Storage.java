package com.summit.dp.shared.storage;

/** H2 文件名与连接名不同，集中定义以免启动判定与建库指向不同位置。 */
public final class H2Storage {
    public static final String DATABASE_FILE_NAME = "lingxi-h2.mv.db";
    public static final String JDBC_DATABASE_NAME = "lingxi-h2";
    public static final String DRIVER_CLASS_NAME = "org.h2.Driver";
    public static final String SCHEMA_LOCATION = "classpath*:db/h2/V*__*.sql";

    private H2Storage() {
    }
}

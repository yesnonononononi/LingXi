package com.summit.dp.shared.storage;

/** 测试连接参数与生产 yaml 的等价性由回归用例约束。 */
public final class StorageDataSourceKeys {
    public static final String SET_TIME_ZONE_UTC = "SET TIME ZONE 'UTC'";

    private StorageDataSourceKeys() {
    }

    public static String h2Url(StorageLayout layout) {
        if (layout == null) {
            throw new IllegalArgumentException("拼 H2 URL 需要数据目录");
        }
        String base = layout.dataDir().resolve(H2Storage.JDBC_DATABASE_NAME).toString().replace('\\', '/');
        return "jdbc:h2:file:" + base
                + ";DB_CLOSE_ON_EXIT=FALSE;FILE_LOCK=FS;AUTO_SERVER=FALSE;TRACE_LEVEL_FILE=0;INIT="
                + SET_TIME_ZONE_UTC;
    }
}

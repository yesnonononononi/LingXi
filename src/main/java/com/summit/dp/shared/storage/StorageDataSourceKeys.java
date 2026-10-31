package com.summit.dp.shared.storage;

import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 把「H2 引擎」翻成一组数据源属性，一次性写进环境。
 *
 * <p><b>为什么在环境期写完所有键，而不是运行期再分支</b>：连接池一旦建起来，URL/驱动/池参数就定死了；
 * 等到能拿到 Bean 再改只能改到一半。这里把 URL、驱动、池参数、校验语句一次写全，
 * 运行期不再有任何「如果是 H2 就……」的分支。</p>
 *
 * <p>时区在两处同时下发（URL 里的 {@code INIT=} 与 Druid 的 {@code connection-init-sqls}）：
 * 前者保证「任何 DataSource（含测试直连）拿到的连接都是 UTC」，后者是连接池层面的显式声明。
 * 两者幂等，缺一处就可能出现「生产 +08、测试 UTC」的静默偏差。</p>
 */
public final class StorageDataSourceKeys {

    /** H2 URL 里给每条新连接的初始化语句：会话时区锁死 UTC，时间列存的就是 UTC 墙钟。 */
    public static final String SET_TIME_ZONE_UTC = "SET TIME ZONE 'UTC'";

    private static final String URL_KEY = "spring.datasource.url";
    private static final String DRIVER_CLASS_NAME_KEY = "spring.datasource.driver-class-name";
    private static final String DRUID_PREFIX = "spring.datasource.druid.";
    private static final String PROPERTY_SOURCE_NAME = "lingxiStorageEngineH2";

    private StorageDataSourceKeys() {
    }

    /**
     * 用 H2 的 URL/驱动/池参数覆盖环境里的 SQLite 缺省值。
     *
     * @param environment 当前环境，不能为空
     * @param layout      数据目录解析结果，用于拼库文件绝对路径
     */
    public static void applyH2(ConfigurableEnvironment environment, StorageLayout layout) {
        if (environment == null || layout == null) {
            throw new IllegalArgumentException("覆写 H2 数据源需要环境与数据目录，两者都不能为空");
        }
        Map<String, Object> overrides = new LinkedHashMap<>();
        overrides.put(URL_KEY, h2Url(layout));
        overrides.put(DRIVER_CLASS_NAME_KEY, StorageEngine.H2.driverClassName());
        overrides.put(DRUID_PREFIX + "connection-init-sqls", SET_TIME_ZONE_UTC);
        // SQLite 是单写者，H2 的 MVStore 支持多读单写：连接池按「少量并发读 + 串行写」定标，
        // 刻意不放大——写冲突靠唯一索引与条件更新裁决，不靠堆连接。
        overrides.put(DRUID_PREFIX + "initial-size", 2);
        overrides.put(DRUID_PREFIX + "min-idle", 2);
        overrides.put(DRUID_PREFIX + "max-active", 8);
        overrides.put(DRUID_PREFIX + "validation-query", "SELECT 1");
        environment.getPropertySources().addFirst(new MapPropertySource(PROPERTY_SOURCE_NAME, overrides));
    }

    /**
     * H2 文件库的完整 JDBC URL。
     *
     * <p>参数含义：{@code DB_CLOSE_ON_EXIT=FALSE} 由 Spring 生命周期关池（避免 JVM 退出钩子里再抢一把锁）；
     * {@code FILE_LOCK=FS} 用文件系统锁（同机多进程也能互斥）；{@code AUTO_SERVER=FALSE} 不开放自动混合模式
     * （那会把库变成多进程共享，冷搬迁时的「复制即损坏」风险更难控）；{@code TRACE_LEVEL_FILE=0}
     * 明确不在数据目录里落 {@code .trace.db}（那是运行时产物，不该出现在用户数据里）；
     * {@code INIT} 让每条新连接都执行一次时区设置。</p>
     *
     * @param layout 数据目录解析结果
     * @return 可直接交给驱动的 URL
     */
    public static String h2Url(StorageLayout layout) {
        if (layout == null) {
            throw new IllegalArgumentException("拼 H2 URL 需要数据目录");
        }
        String base = layout.dataDir()
                .resolve(StorageEngine.H2.jdbcDatabaseName())
                .toAbsolutePath()
                .normalize()
                .toString()
                .replace('\\', '/');
        return "jdbc:h2:file:" + base
                + ";DB_CLOSE_ON_EXIT=FALSE"
                + ";FILE_LOCK=FS"
                + ";AUTO_SERVER=FALSE"
                + ";TRACE_LEVEL_FILE=0"
                + ";INIT=" + SET_TIME_ZONE_UTC;
    }
}

package com.summit.dp.shared.support;

import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.persistence.H2ExceptionTranslator;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.storage.StorageDataSourceKeys;
import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.shared.storage.StorageLayout;
import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import org.apache.ibatis.session.ExecutorType;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * 测试用真实 H2 文件库。
 *
 * <p><b>为什么必须是文件库</b>：本轮要验证的东西（DDL 落盘形态、CLOB 落盘、identity、生成列、
 * 唯一索引裁决、关闭重开后能否打开、锁冲突）恰好都是 {@code jdbc:h2:mem:} 会绕过去的部分。
 * 内存库冒充文件库在本任务里是明令禁止的。</p>
 *
 * <p><b>位置</b>：库文件落在系统临时目录 {@code <java.io.tmpdir>/lingxi-h2-verify/} 下的一次性目录里，
 * 用例结束（或进程退出）时整目录删除；绝不在仓库工作区、{@code ~/.lingxi}、
 * {@code .lingxi/development} 下建库，也不留 {@code .mv.db}/{@code .trace.db}/{@code .log}。</p>
 *
 * <p><b>连接串与生产完全同源</b>：URL 由 {@link StorageDataSourceKeys#h2Url(StorageLayout)} 生成，
 * 因此测试里验证到的时区、文件锁、trace 关闭等行为就是生产行为，不存在「测试库和生产库两套参数」。</p>
 */
public final class H2TestDatabase implements DataSource, AutoCloseable {

    private final Path directory;
    private final Path databaseFile;
    private final DriverManagerDataSource delegate;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private H2TestDatabase(Path directory) {
        this.directory = directory;
        this.databaseFile = directory.resolve(H2Storage.DATABASE_FILE_NAME);
        this.delegate = new DriverManagerDataSource();
        delegate.setDriverClassName(H2Storage.DRIVER_CLASS_NAME);
        delegate.setUrl(StorageDataSourceKeys.h2Url(new StorageLayout(directory)));
        Runtime.getRuntime().addShutdownHook(new Thread(this::shutdown, "h2-test-db-cleanup"));
    }

    /**
     * 建一个临时文件库并执行生产 H2 建库脚本。
     *
     * @param prefix 目录前缀，便于排查是哪个用例留下的库
     * @return 已建好全部业务表的文件库
     * @throws IllegalStateException 建库脚本一条都没执行（说明初始器判定「已最新」而库其实是空的）
     */
    public static H2TestDatabase create(String prefix) {
        H2TestDatabase database = createWithoutSchema(prefix);
        int executed = new H2SchemaInitializer().initialize(database);
        if (executed <= 0) {
            database.shutdown();
            throw new IllegalStateException("测试用 H2 库建库脚本一个都没执行: prefix=" + prefix);
        }
        return database;
    }

    /**
     * 只开库不建表：迁库/可重入类用例需要「空库」这个起点。
     *
     * @param prefix 目录前缀
     * @return 空库数据源
     */
    public static H2TestDatabase createWithoutSchema(String prefix) {
        try {
            Path root = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-h2-verify");
            Files.createDirectories(root);
            Path directory = Files.createTempDirectory(root, "h2-" + prefix + "-");
            // 测试库位置守卫：宁可当场失败，也不许把库建到真实用户数据目录里（设计 §附录D.3）。
            StorageIsolationGuard.require(directory);
            return new H2TestDatabase(directory);
        } catch (IOException e) {
            throw new UncheckedIOException("测试用 H2 库目录创建失败: prefix=" + prefix, e);
        }
    }

    /** Spring 自建连接池时仍使用隔离的文件库，清理由退出钩子负责。 */
    public static String newDatasourceUrl(String prefix) {
        H2TestDatabase database = createWithoutSchema(prefix);
        return StorageDataSourceKeys.h2Url(new StorageLayout(database.directory()));
    }

    /** 执行一段 SQL（可含多条语句），用于按需构造形态或校验语句。 */
    public void execute(String sql) {
        try (Connection connection = delegate.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException e) {
            throw new IllegalStateException("测试库 SQL 执行失败: " + e.getMessage(), e);
        }
    }

    /** 查询单个标量，用于断言库侧事实（版本号、类型、行数）。 */
    public String queryString(String sql) {
        try (Connection connection = delegate.getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException("测试库查询失败: " + e.getMessage(), e);
        }
    }

    /** 查询单列多行，用于表清单/列清单断言。 */
    public List<String> queryColumn(String sql) {
        List<String> values = new ArrayList<>();
        try (Connection connection = delegate.getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                values.add(rows.getString(1));
            }
        } catch (SQLException e) {
            throw new IllegalStateException("测试库查询失败: " + e.getMessage(), e);
        }
        return values;
    }

    /** 直接开一个连接（需要手工控制事务/锁的用例用它）。 */
    public Connection openConnection() throws SQLException {
        return delegate.getConnection();
    }

    /**
     * 构造一个已登记 H2 类型处理器、开启驼峰映射的 MyBatis-Plus 配置。
     *
     * <p>手搓 SqlSessionFactory 的用例（没有 Spring 就没有包扫描）必须走这里，
     * 否则 Instant / LocalDateTime 会落回 MyBatis 内置处理器，在 H2 上按 JVM 默认时区解释，
     * 出现「读回来差 8 小时」的假失败。</p>
     *
     * @param mappers 需要注册的 Mapper 接口
     * @return 可用于构造 SqlSessionFactory 的配置
     */
    public MybatisConfiguration configuration(Class<?>... mappers) {
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        for (Class<?> mapper : mappers) {
            configuration.addMapper(mapper);
        }
        return configuration;
    }

    /** 用本库的数据源构造 SqlSessionFactory（含 H2 分页方言）。 */
    public SqlSessionFactory sessionFactory(Class<?>... mappers) {
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(this);
        factory.setConfiguration(configuration(mappers));
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        try {
            return factory.getObject();
        } catch (Exception e) {
            throw new IllegalStateException("H2 测试 SqlSessionFactory 创建失败: " + e.getMessage(), e);
        }
    }

    /**
     * 用 H2 异常翻译器包装 SqlSessionFactory。
     *
     * <p>唯一键冲突必须落成 {@code DuplicateKeyException}；用默认构造器会走 Spring 的 SQLState
     * 分类，H2 的若干高频错误（锁超时 50200）会被归成不可重试的未知错误。</p>
     *
     * @param factory 会话工厂
     * @return 带异常翻译的模板
     */
    public static SqlSessionTemplate sqlSession(SqlSessionFactory factory) {
        return new SqlSessionTemplate(factory, ExecutorType.SIMPLE,
                new H2ExceptionTranslator(factory.getConfiguration().getEnvironment().getDataSource()));
    }

    /** 库文件路径（H2 的 {@code .mv.db}）。 */
    public Path databaseFile() {
        return databaseFile;
    }

    /** 本次一次性目录（断言「工作区没有残留」时用）。 */
    public Path directory() {
        return directory;
    }

    /** 关闭并删除库文件；重复调用幂等。 */
    public void shutdown() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        deleteQuietly(directory);
    }

    @Override
    public void close() {
        shutdown();
    }

    private static void deleteQuietly(Path directory) {
        if (directory == null || !Files.exists(directory)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // 文件仍被未关闭的连接占着时删不掉：临时目录由系统兜底，不掩盖用例失败。
                }
            });
        } catch (IOException ignored) {
            // 同上。
        }
    }

    @Override
    public Connection getConnection() throws SQLException {
        return delegate.getConnection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return delegate.getConnection(username, password);
    }

    @Override
    public PrintWriter getLogWriter() throws SQLException {
        return delegate.getLogWriter();
    }

    @Override
    public void setLogWriter(PrintWriter out) throws SQLException {
        delegate.setLogWriter(out);
    }

    @Override
    public void setLoginTimeout(int seconds) throws SQLException {
        delegate.setLoginTimeout(seconds);
    }

    @Override
    public int getLoginTimeout() throws SQLException {
        return delegate.getLoginTimeout();
    }

    @Override
    public Logger getParentLogger() {
        return Logger.getLogger("org.h2");
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
        if (iface.isInstance(this)) {
            return iface.cast(this);
        }
        return delegate.unwrap(iface);
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) throws SQLException {
        return iface.isInstance(this) || delegate.isWrapperFor(iface);
    }
}

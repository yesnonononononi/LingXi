package com.summit.dp.shared.support;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.baomidou.mybatisplus.annotation.DbType;
import com.summit.dp.shared.config.SqliteSchemaInitializer;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.persistence.SqliteExceptionTranslator;
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
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * 测试用真实 SQLite 文件库。
 *
 * <p><b>为什么必须是文件库而不是 {@code :memory:}</b>：WAL、写锁竞争、跨连接可见性、
 * 重启后能否打开，这些恰好是本轮要验证的东西，内存库把它们全部绕过去了。</p>
 *
 * <p>库文件落在系统临时目录，用例结束时连同 {@code -wal/-shm} 一起删除，
 * 绝不在工作区留运行产物。</p>
 *
 * <p>对外仍是一个 {@link DataSource}，并额外提供 {@link #shutdown()}，
 * 因此既能直接喂给事务管理器，也能替换旧的嵌入式库用法。</p>
 */
public final class SqliteTestDatabase implements DataSource, AutoCloseable {

    /**
     * 与生产一致的连接参数（busy_timeout 也保持一致 5s）。
     *
     * <p>刻意不放大等待时间：放大只能掩盖真实的锁竞争，会让用例在真死锁时长时间挂住，
     * 也会让测试与生产行为出现差异。事务模式同样不设（DEFERRED），与生产一致。</p>
     */
    private static final String PARAMETERS =
            "?journal_mode=WAL&synchronous=FULL&busy_timeout=5000&foreign_keys=false";

    private final Path directory;
    private final Path databaseFile;
    private final DriverManagerDataSource delegate;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private SqliteTestDatabase(Path directory) {
        this.directory = directory;
        this.databaseFile = directory.resolve("lingxi.sqlite");
        this.delegate = new DriverManagerDataSource();
        delegate.setDriverClassName("org.sqlite.JDBC");
        delegate.setUrl("jdbc:sqlite:" + databaseFile.toAbsolutePath().toString().replace('\\', '/') + PARAMETERS);
        Runtime.getRuntime().addShutdownHook(new Thread(this::shutdown, "sqlite-test-db-cleanup"));
    }

    /**
     * 建一个临时文件库并执行生产建库脚本。
     *
     * @param prefix 临时目录前缀，便于排查是哪个用例留下的库
     */
    public static SqliteTestDatabase create(String prefix) {
        try {
            Path directory = Files.createTempDirectory("lingxi-sqlite-" + prefix + "-");
            SqliteTestDatabase database = new SqliteTestDatabase(directory);
            int executed = new SqliteSchemaInitializer().initialize(database);
            if (executed <= 0) {
                throw new IllegalStateException("测试库建库脚本一个都没执行: prefix=" + prefix);
            }
            return database;
        } catch (IOException e) {
            throw new UncheckedIOException("测试用 SQLite 库创建失败: prefix=" + prefix, e);
        }
    }

    /**
     * 为 Spring 上下文预置独立文件库：返回可直接写进配置的 JDBC URL，目录在进程退出时清理。
     *
     * <p>Spring 上下文里库是容器自己建的，测试拿不到 {@link #create(String)} 的实例，
     * 因此这里只负责挑位置并登记清理；建表由生产初始化器在容器启动时完成。</p>
     */
    public static String newDatasourceUrl(String prefix) {
        try {
            Path directory = Files.createTempDirectory("lingxi-sqlite-" + prefix + "-");
            Path file = directory.resolve("lingxi.sqlite");
            Runtime.getRuntime().addShutdownHook(
                    new Thread(() -> deleteQuietly(directory), "sqlite-spring-db-cleanup"));
            return "jdbc:sqlite:" + file.toAbsolutePath().toString().replace('\\', '/') + PARAMETERS;
        } catch (IOException e) {
            throw new UncheckedIOException("测试用 SQLite 库路径创建失败: prefix=" + prefix, e);
        }
    }

    /** 执行一段 SQL（可含多条语句），用于按需构造历史形状或校验语句。 */
    public void execute(String sql) {
        try (Connection connection = delegate.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException e) {
            throw new IllegalStateException("测试库 SQL 执行失败: " + e.getMessage(), e);
        }
    }

    /** 查询单个标量，用于断言库侧事实（版本号、行数、时间文本）。 */
    public String queryString(String sql) {
        try (Connection connection = delegate.getConnection();
             Statement statement = connection.createStatement();
             var rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException("测试库查询失败: " + e.getMessage(), e);
        }
    }

    /**
     * 构造一个已登记时间类型处理器、开启驼峰映射与分页方言的 MyBatis-Plus 配置。
     *
     * <p>手搓 SqlSessionFactory 的用例（没有 Spring 就没有类型处理器扫描）必须走这里，
     * 否则 Instant / LocalDateTime 会落回 MyBatis 内置处理器，在 SQLite 上必然抛解析错误。</p>
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

    /** 用本库的数据源构造 SqlSessionFactory（含 SQLite 分页方言）。 */
    public SqlSessionFactory sessionFactory(Class<?>... mappers) {
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(this);
        factory.setConfiguration(configuration(mappers));
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.SQLITE));
        factory.setPlugins(plugins);
        try {
            return factory.getObject();
        } catch (Exception e) {
            throw new IllegalStateException("测试 SqlSessionFactory 创建失败: " + e.getMessage(), e);
        }
    }

    /**
     * 用 SQLite 异常翻译器包装 SqlSessionFactory。
     *
     * <p>默认构造器走 Spring 的 SQLState 分类，而 SQLite 约束冲突的 SQLState 是 null，
     * 会落成 {@code UncategorizedSQLException} —— 唯一键幂等逻辑就静默失效了。</p>
     */
    public static SqlSessionTemplate sqlSession(SqlSessionFactory factory) {
        return new SqlSessionTemplate(factory, ExecutorType.SIMPLE,
                new SqliteExceptionTranslator(factory.getConfiguration().getEnvironment().getDataSource()));
    }

    public Path databaseFile() {
        return databaseFile;
    }

    /** 关闭并删除库文件（含 WAL 伴随文件）；重复调用幂等。 */
    public void shutdown() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        deleteQuietly(directory);
    }

    private static void deleteQuietly(Path directory) {
        try (Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // 文件仍被未关闭的连接占着时删不掉：临时目录由系统兜底清理，不掩盖用例失败。
                }
            });
        } catch (IOException ignored) {
            // 同上：清理问题不应盖住真正的断言失败。
        }
    }

    @Override
    public void close() {
        shutdown();
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
        return Logger.getLogger("org.sqlite");
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

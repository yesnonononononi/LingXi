package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.schema.SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.persistence.schema.SchemaScriptLoader;
import com.summit.dp.shared.storage.StorageEngine;
import lombok.extern.slf4j.Slf4j;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * SQLite 建库与版本化初始化。
 *
 * <p><b>为什么是「版本表 + 顺序执行脚本」而不是原来的补列补表</b>：旧流程要先探测缺哪张表、缺哪一列，
 * 再逐个跑 ALTER，这套逻辑只在「从很老的历史库升上来」时才有意义；方案已明确新建 SQLite 库、
 * 不导入任何旧库数据，因此运行期只剩一件事：把还没执行过的版本脚本按序执行一遍。</p>
 *
 * <p>整个初始化在一个事务里完成：脚本执行到一半失败就整体回滚，不会留下「建了一半的表 +
 * 已经登记的版本号」这种既跑不下去又重复不了的状态。重复执行幂等 —— 已登记的版本直接跳过，
 * 这让它在每次启动时都可以安全地跑。</p>
 *
 * <p>脚本的加载、切分、指纹计算已抽到 {@link SchemaScriptLoader}（H2 侧共用同一实现）；
 * 本类只保留 SQLite 专属的部分：单事务、文本时间默认值、无指纹比对的旧登记表结构。</p>
 *
 * <p>它不是 Spring 配置类：注册 runner 的职责已收拢到 {@link SchemaBootstrapConfig}，
 * 本类只负责「怎么建库」，因此既能在容器里用，也能被测试直接 {@code new} 出来跑。</p>
 */
@Slf4j
public class SqliteSchemaInitializer implements SchemaInitializer {

    /** 版本登记表名；建表语句本身也必须幂等。 */
    private static final String VERSION_TABLE = "schema_version";

    private static final String SCRIPT_LOCATION = StorageEngine.SQLITE.schemaLocation();

    private final SchemaScriptLoader loader = new SchemaScriptLoader();

    @Override
    public String engineId() {
        return StorageEngine.SQLITE.id();
    }

    /**
     * 执行所有尚未登记的版本脚本。
     *
     * @param dataSource 目标库；必须是 SQLite
     * @return 本次实际执行的脚本个数（0 表示库已是最新）
     */
    @Override
    public int initialize(DataSource dataSource) {
        List<SchemaScript> scripts = loader.load(SCRIPT_LOCATION);
        if (scripts.isEmpty()) {
            throw new IllegalStateException("classpath 上没有找到 SQLite 建库脚本: " + SCRIPT_LOCATION);
        }
        try (Connection connection = dataSource.getConnection()) {
            boolean originalAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                createVersionTable(connection);
                Set<Integer> applied = readAppliedVersions(connection);
                int executed = 0;
                for (SchemaScript script : scripts) {
                    if (applied.contains(script.version())) {
                        continue;
                    }
                    execute(connection, script);
                    recordVersion(connection, script);
                    executed++;
                }
                connection.commit();
                log.info("SQLite 建库完成: executed={}, total={}", executed, scripts.size());
                return executed;
            } catch (SQLException | RuntimeException failure) {
                connection.rollback();
                throw new IllegalStateException("SQLite 建库脚本执行失败，本次升级已回滚: "
                        + failure.getMessage(), failure);
            } finally {
                connection.setAutoCommit(originalAutoCommit);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("SQLite 建库失败: " + e.getMessage(), e);
        }
    }

    private void createVersionTable(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE IF NOT EXISTS " + VERSION_TABLE
                    + " (version INTEGER PRIMARY KEY, script TEXT NOT NULL, applied_at TEXT NOT NULL)");
        }
    }

    private Set<Integer> readAppliedVersions(Connection connection) throws SQLException {
        Set<Integer> applied = new HashSet<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT version FROM " + VERSION_TABLE)) {
            while (rows.next()) {
                applied.add(rows.getInt(1));
            }
        }
        return applied;
    }

    /** 逐条执行：破坏性语句在启动期拒绝，语句级报错必须带「第几条」。 */
    private void execute(Connection connection, SchemaScript script) throws SQLException {
        loader.requireNonDestructive(script);
        List<String> statements = loader.splitStatements(script);
        try (Statement statement = connection.createStatement()) {
            for (int index = 0; index < statements.size(); index++) {
                String sql = statements.get(index);
                try {
                    statement.execute(sql);
                } catch (SQLException failure) {
                    throw new SQLException("建库脚本第 " + (index + 1) + " 条语句执行失败: " + script.filename()
                            + "，语句开头=" + sql.substring(0, Math.min(80, sql.length())).replace('\n', ' ')
                            + "，原因=" + failure.getMessage(), failure);
                }
            }
        }
    }

    private void recordVersion(Connection connection, SchemaScript script) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO " + VERSION_TABLE + " (version, script, applied_at)"
                        + " VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))")) {
            insert.setInt(1, script.version());
            insert.setString(2, script.filename());
            insert.executeUpdate();
        }
    }
}

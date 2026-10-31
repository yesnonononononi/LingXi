package com.summit.dp.shared.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
 */
@Slf4j
@Configuration
public class SqliteSchemaInitializer {

    /** 版本登记表名；建表语句本身也必须幂等。 */
    private static final String VERSION_TABLE = "schema_version";

    private static final String SCRIPT_LOCATION = "classpath*:db/sqlite/V*__*.sql";

    /** 脚本命名：V<版本>__<说明>.sql；版本号决定执行顺序。 */
    private static final Pattern SCRIPT_NAME = Pattern.compile("^V(\\d+)__(.+)\\.sql$");

    /** 破坏性语句在启动期一律拒绝：建库脚本只允许 IF NOT EXISTS 的增量建表。 */
    private static final Pattern DESTRUCTIVE = Pattern.compile(
            "(?im)^\\s*(?:DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\b");

    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public ApplicationRunner sqliteSchemaBootstrap(DataSource dataSource) {
        return args -> initialize(dataSource);
    }

    /**
     * 执行所有尚未登记的版本脚本。
     *
     * @param dataSource 目标库；必须是 SQLite
     * @return 本次实际执行的脚本个数（0 表示库已是最新）
     */
    public int initialize(DataSource dataSource) {
        List<SchemaScript> scripts = loadScripts();
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

    /** 读 classpath 上全部版本脚本，按版本号升序；同版本号重复即配置错误。 */
    private List<SchemaScript> loadScripts() {
        List<SchemaScript> scripts = new ArrayList<>();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver()
                    .getResources(SCRIPT_LOCATION);
            for (Resource resource : resources) {
                String filename = resource.getFilename();
                if (filename == null) {
                    continue;
                }
                Matcher matcher = SCRIPT_NAME.matcher(filename);
                if (!matcher.matches()) {
                    continue;
                }
                scripts.add(new SchemaScript(Integer.parseInt(matcher.group(1)), filename,
                        new String(resource.getInputStream().readAllBytes(), StandardCharsets.UTF_8)));
            }
        } catch (IOException e) {
            throw new IllegalStateException("读取 SQLite 建库脚本失败: " + e.getMessage(), e);
        }
        scripts.sort(Comparator.comparingInt(SchemaScript::version));
        Set<Integer> versions = new HashSet<>();
        for (SchemaScript script : scripts) {
            if (!versions.add(script.version())) {
                throw new IllegalStateException("建库脚本版本号重复: V" + script.version());
            }
        }
        return scripts;
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

    private void execute(Connection connection, SchemaScript script) throws SQLException {
        if (DESTRUCTIVE.matcher(script.content()).find()) {
            throw new IllegalStateException("建库脚本包含破坏性语句，已拒绝执行: " + script.filename());
        }
        List<String> statements = splitStatements(script);
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

    /**
     * 把脚本切成单条语句。
     *
     * <p><b>为什么不直接把整段脚本丢给驱动</b>：实测 sqlite-jdbc 的 {@code execute} 遇到以注释开头的
     * 多语句脚本时只执行第一条（后续语句被静默跳过），表现为「库建了一半、日志还说成功」。
     * 因此这里自己切分，并逐条执行、逐条报错。</p>
     *
     * <p>触发器体的 {@code BEGIN ... END;} 内部含分号，按行判断「是否在触发器体内」再决定是否切分。</p>
     */
    private static List<String> splitStatements(SchemaScript script) {
        List<String> statements = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inTrigger = false;
        for (String rawLine : script.content().split("\n")) {
            String trimmed = rawLine.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("--")) {
                continue;
            }
            current.append(rawLine).append('\n');
            String upper = trimmed.toUpperCase(Locale.ROOT);
            if (!inTrigger && upper.startsWith("CREATE TRIGGER")) {
                inTrigger = true;
            }
            if (inTrigger) {
                if (upper.endsWith("END;")) {
                    statements.add(current.toString());
                    current.setLength(0);
                    inTrigger = false;
                }
                continue;
            }
            if (trimmed.endsWith(";")) {
                statements.add(current.toString());
                current.setLength(0);
            }
        }
        if (!current.isEmpty()) {
            throw new IllegalStateException("建库脚本末尾存在不完整语句: " + script.filename());
        }
        return statements;
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

    /** 一个版本脚本：版本号、文件名、正文。 */
    private record SchemaScript(int version, String filename, String content) {
    }
}

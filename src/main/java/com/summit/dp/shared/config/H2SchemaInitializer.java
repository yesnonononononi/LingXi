package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.schema.SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.persistence.schema.SchemaScriptLoader;
import com.summit.dp.shared.storage.H2Storage;
import lombok.extern.slf4j.Slf4j;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * H2 建库：幂等脚本 + 指纹守卫 + 逐版本登记 + 期望对象校验。
 *
 * <p><b>为什么不承诺整事务回滚</b>：实测 H2 2.5.252 的 DDL 会隐式提交 ——
 * {@code SET AUTOCOMMIT FALSE} → {@code CREATE TABLE} → {@code ROLLBACK} 之后表还在。
 * 因此这里不做「失败即回滚」的假承诺，而用三件事保证可重入：
 * ① 脚本里每条语句都带 {@code IF NOT EXISTS}；② 版本登记放在「语句全成功 + 对象与期望表清单
 * 全部核对通过」之后；③ 已登记版本再做指纹比对。半建状态因此只可能表现为「下次启动重跑同一脚本」，
 * 而重跑是幂等的。</p>
 *
 * <p><b>为什么版本登记必须最后写</b>：先登记后执行会让中断留下「版本说已建好、表其实缺」的状态，
 * 旧 init.sql 的补列式迁移正是这种隐患形态。反过来只付出「重跑一遍幂等脚本」的代价。</p>
 */
@Slf4j
public class H2SchemaInitializer implements SchemaInitializer {

    /** 版本登记表；建表语句本身也必须幂等。 */
    private static final String VERSION_TABLE = "schema_version";

    /** 版本表建表语句：时间列与业务表同口径（TIMESTAMP(3)，会话已锁 UTC）。 */
    private static final String CREATE_VERSION_TABLE = "CREATE TABLE IF NOT EXISTS " + VERSION_TABLE
            + " (version INTEGER PRIMARY KEY, script VARCHAR(128) NOT NULL, checksum VARCHAR(64) NOT NULL,"
            + " applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)";

    /**
     * H2 建库必须产出的全部业务表。
     *
     * <p>这是「建库完成」的硬标准：任何一张缺失都说明脚本没跑完（或没跑），
     * 此时绝不登记版本，下次启动重跑补齐。清单与 {@code db/h2/V1__schema.sql} 的一致性由
     * {@code H2SchemaPoConsistencyTest} 守着。</p>
     */
    private static final List<String> EXPECTED_TABLES = List.of(
            "mcp", "provider_config", "model_config", "workspace", "session", "session_message",
            "session_context", "user_configs", "agent", "team", "execution", "chat_turn", "tool_call",
            "execution_resume_task", "email", "email_message", "email_message_receipt",
            "runtime_config_revision", "task",
            "checklist", "checklist_step", "session_token_audit", "session_token_audit_item",
            // 文件编辑记录（V12）：跨进程存活的改动清单，基线正文在数据目录、库内只留引用。
            "file_record",
            // 指令预测（V15）：每轮一条的衍生结论，(session_id, turn_id) 唯一。
            "instruction_predict");

    /** 从 SQLite 抄过来的写法一律拒绝：自增、SQL 触发器体、切模式、虚拟列在 H2 都不成立。 */
    private static final Pattern FORBIDDEN_IN_H2 = Pattern.compile(
            "(?i)(?:\\bAUTOINCREMENT\\b|^\\s*CREATE\\s+TRIGGER\\b|\\bMODE\\s*=|\\bVIRTUAL\\b)");

    private static final Pattern CREATE_TABLE_NAME = Pattern.compile(
            "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)", Pattern.CASE_INSENSITIVE);

    private static final Pattern CREATE_INDEX_NAME = Pattern.compile(
            "CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)", Pattern.CASE_INSENSITIVE);

    private final SchemaScriptLoader loader = new SchemaScriptLoader();

    @Override
    public String engineId() {
        return "h2";
    }

    /** 期望表清单（供一致性测试核对脚本与实现没有漂移）。 */
    public static List<String> expectedTables() {
        return EXPECTED_TABLES;
    }

    /**
     * 执行所有尚未登记的版本脚本（生产入口：脚本来自 classpath）。
     *
     * @param dataSource 目标库；必须是 H2
     * @return 本次实际执行的脚本个数（0 表示库已是最新）
     */
    @Override
    public int initialize(DataSource dataSource) {
        return initialize(dataSource, loadScripts());
    }

    /** 读 classpath 上的 H2 脚本；一个都没有即配置错误（不会静默跳过建库）。 */
    public List<SchemaScript> loadScripts() {
        List<SchemaScript> scripts = loader.load(H2Storage.SCHEMA_LOCATION);
        if (scripts.isEmpty()) {
            throw new IllegalStateException("classpath 上没有找到 H2 建库脚本: "
                    + H2Storage.SCHEMA_LOCATION);
        }
        return scripts;
    }

    /**
     * 用给定脚本集执行建库（测试与工具复用；生产走 {@link #initialize(DataSource)}）。
     *
     * @param dataSource 目标库
     * @param scripts    版本脚本集（内部按版本号升序处理）
     * @return 本次实际执行的脚本个数
     */
    public int initialize(DataSource dataSource, List<SchemaScript> scripts) {
        if (dataSource == null) {
            throw new IllegalArgumentException("建库需要目标数据源");
        }
        if (scripts == null || scripts.isEmpty()) {
            throw new IllegalArgumentException("建库脚本集不能为空");
        }
        List<SchemaScript> ordered = new ArrayList<>(scripts);
        ordered.sort((left, right) -> Integer.compare(left.version(), right.version()));
        try (Connection connection = dataSource.getConnection()) {
            createVersionTable(connection);
            Map<Integer, String> applied = readApplied(connection);
            int executed = 0;
            // 期望表集合按版本累积，且取自 classpath 上的权威脚本（不是本次传入的可能被改坏的那份）：
            // 「少建了一张表」必须能被抓住，所以期望清单不能由被测内容自己声明。
            Map<Integer, Set<String>> authoritative = declaredTablesByVersion(loadScripts());
            Set<String> expected = new LinkedHashSet<>();
            for (SchemaScript script : ordered) {
                expected.addAll(authoritative.getOrDefault(script.version(), declaredTables(script)));
                String appliedChecksum = applied.get(script.version());
                if (appliedChecksum != null) {
                    // 口径无关比对：换行符差异（CRLF/LF）与历史直算口径的指纹都算「同一脚本」，
                    // 只有语义内容真的变了才拒绝。详见 SchemaScriptLoader#acceptedChecksums。
                    if (!loader.matchesRegistered(appliedChecksum, script.content())) {
                        throw new IllegalStateException("H2 建库脚本已被修改但版本号没升（已登记指纹 "
                                + appliedChecksum + "，当前 " + script.checksum() + "），拒绝启动: "
                                + script.filename() + "。改了已发布的脚本就新增 V<n>__*.sql，不要原地改。");
                    }
                    continue;
                }
                executeIdempotent(connection, script);
                verifyObjects(connection, script);
                verifyExpectedTables(connection, expected);
                recordVersion(connection, script);
                executed++;
            }
            log.info("H2 建库完成: executed={}, total={}", executed, ordered.size());
            return executed;
        } catch (SQLException e) {
            throw new IllegalStateException("H2 建库失败: " + e.getMessage(), e);
        }
    }

    /** 版本表自身也要幂等：首次启动建，之后无事发生。 */
    private void createVersionTable(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(CREATE_VERSION_TABLE);
        }
    }

    /** 已登记版本 → 当时的脚本指纹；顺序无关，用 {@link LinkedHashMap} 只为日志可读。 */
    private Map<Integer, String> readApplied(Connection connection) throws SQLException {
        Map<Integer, String> applied = new LinkedHashMap<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT version, checksum FROM " + VERSION_TABLE + " ORDER BY version")) {
            while (rows.next()) {
                applied.put(rows.getInt(1), rows.getString(2));
            }
        }
        return applied;
    }

    /** 逐条执行脚本语句；每条都做「非破坏性 + H2 兼容」检查，失败时指出第几条与语句开头。 */
    private void executeIdempotent(Connection connection, SchemaScript script) {
        loader.requireNonDestructive(script);
        List<String> statements = loader.splitStatements(script);
        if (statements.isEmpty()) {
            throw new IllegalStateException("H2 建库脚本里没有任何可执行语句: " + script.filename());
        }
        for (int index = 0; index < statements.size(); index++) {
            String sql = statements.get(index);
            Matcher forbidden = FORBIDDEN_IN_H2.matcher(sql);
            if (forbidden.find()) {
                throw new IllegalStateException("H2 建库脚本出现 H2 不支持的写法(" + forbidden.group()
                        + ")，已拒绝执行: " + script.filename() + "，语句开头=" + preview(sql));
            }
            try (Statement statement = connection.createStatement()) {
                statement.execute(sql);
            } catch (SQLException failure) {
                throw new IllegalStateException("H2 建库脚本第 " + (index + 1) + " 条语句执行失败: "
                        + script.filename() + "，语句开头=" + preview(sql)
                        + "，原因=" + failure.getMessage(), failure);
            }
        }
    }

    /** 脚本声明的表/索引必须都能在 INFORMATION_SCHEMA 里查到，否则视为没建成。 */
    private void verifyObjects(Connection connection, SchemaScript script) throws SQLException {
        List<String> missing = new ArrayList<>();
        for (String table : namesOf(CREATE_TABLE_NAME, script)) {
            if (!tableExists(connection, table)) {
                missing.add("表 " + table);
            }
        }
        for (String index : namesOf(CREATE_INDEX_NAME, script)) {
            if (!indexExists(connection, index)) {
                missing.add("索引 " + index);
            }
        }
        if (!missing.isEmpty()) {
            throw new IllegalStateException("H2 建库脚本执行后对象缺失，未登记版本: " + script.filename()
                    + "，缺失=" + missing);
        }
    }

    /** 期望业务表全部存在才算建库完成；缺一张就抛错并保持「未登记」，下次启动重跑补齐。 */
    private void verifyExpectedTables(Connection connection, Set<String> expected) throws SQLException {
        List<String> missing = new ArrayList<>();
        for (String table : expected) {
            if (!tableExists(connection, table)) {
                missing.add(table);
            }
        }
        if (!missing.isEmpty()) {
            throw new IllegalStateException("H2 建库未完成，缺少业务表，未登记版本: " + missing);
        }
    }

    /** 该脚本声明的表集合（小写）。 */
    private static Set<String> declaredTables(SchemaScript script) {
        Set<String> tables = new LinkedHashSet<>();
        Matcher matcher = CREATE_TABLE_NAME.matcher(script.content());
        while (matcher.find()) {
            tables.add(matcher.group(1).toLowerCase(java.util.Locale.ROOT));
        }
        return tables;
    }

    /** 版本号 → 该版本权威脚本声明的表集合。 */
    private static Map<Integer, Set<String>> declaredTablesByVersion(List<SchemaScript> scripts) {
        Map<Integer, Set<String>> byVersion = new LinkedHashMap<>();
        for (SchemaScript script : scripts) {
            byVersion.put(script.version(), declaredTables(script));
        }
        return byVersion;
    }

    /** 只有上面全部通过才会走到这里：登记版本与指纹。 */
    private void recordVersion(Connection connection, SchemaScript script) throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO " + VERSION_TABLE + " (version, script, checksum, applied_at)"
                        + " VALUES (?, ?, ?, CURRENT_TIMESTAMP)")) {
            insert.setInt(1, script.version());
            insert.setString(2, script.filename());
            insert.setString(3, script.checksum());
            insert.executeUpdate();
        }
    }

    private boolean tableExists(Connection connection, String table) throws SQLException {
        try (PreparedStatement query = connection.prepareStatement(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC' AND UPPER(TABLE_NAME) = ?")) {
            query.setString(1, table.toUpperCase(java.util.Locale.ROOT));
            try (ResultSet rows = query.executeQuery()) {
                return rows.next() && rows.getInt(1) > 0;
            }
        }
    }

    private boolean indexExists(Connection connection, String index) throws SQLException {
        try (PreparedStatement query = connection.prepareStatement(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.INDEXES"
                        + " WHERE UPPER(INDEX_NAME) = ?")) {
            query.setString(1, index.toUpperCase(java.util.Locale.ROOT));
            try (ResultSet rows = query.executeQuery()) {
                return rows.next() && rows.getInt(1) > 0;
            }
        }
    }

    private static Set<String> namesOf(Pattern pattern, SchemaScript script) {
        Set<String> names = new LinkedHashSet<>();
        Matcher matcher = pattern.matcher(script.content());
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }

    private static String preview(String sql) {
        String single = sql.replaceAll("\\s+", " ").strip();
        return single.length() <= 80 ? single : single.substring(0, 80);
    }
}

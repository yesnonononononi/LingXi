package com.summit.dp.shared;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * H2 基线 DDL 的结构守卫：与 PO 对齐、大文本必须是真 CLOB、时间必须是 TIMESTAMP(3)、
 * 唯一索引名字与列序、生成列与 identity。
 *
 * <p><b>这条用例是「变异必须能变红」的门槛</b>：把附录 A.2 里任何一列从 {@code CLOB} 改回
 * {@code TEXT}/{@code VARCHAR}，或把 {@code context_ratio} 改回 {@code NUMERIC(6,4)}，
 * 这里的断言都会失败 —— 因为 H2 的 {@code TEXT} 其实是
 * {@code CHARACTER VARYING(1000000000)}（10 亿字符的 VARCHAR），正是旧 OOM 事故的根因。</p>
 */
class H2SchemaPoConsistencyTest {

    /** 全部持久化 PO；新增 PO 必须登记到这里，否则本守卫覆盖不到它。 */
    private static final List<Class<?>> PO_CLASSES = List.of(
            SessionPO.class,
            com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO.class,
            com.summit.dp.session.infrastructure.persistence.po.SessionContextPO.class,
            com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO.class,
            com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO.class,
            com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO.class,
            com.summit.dp.provider.infrastructure.persistence.po.ProviderConfigPO.class,
            com.summit.dp.workspace.infrastructure.persistence.po.WorkspacePO.class,
            com.summit.dp.agent.infrastructure.persistence.po.AgentPO.class,
            com.summit.dp.team.infrastructure.persistence.po.TeamPO.class,
            com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO.class,
            com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO.class,
            com.summit.dp.execution.infrastructure.persistence.po.RuntimeConfigRevisionPO.class,
            com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO.class,
            com.summit.dp.email.infrastructure.persistence.po.EmailPO.class,
            com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO.class,
            com.summit.dp.mcp.infrastructure.persistence.po.McpPO.class,
            com.summit.dp.task.infrastructure.persistence.po.TaskPO.class,
            com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO.class,
            com.summit.dp.checklist.infrastructure.persistence.po.ChecklistStepPO.class);

    /** 附录 A.2 的大文本列清单（逐列核对，缺一即错）。 */
    private static final List<String> LARGE_TEXT_COLUMNS = List.of(
            "session_context.content",
            "session_message.content",
            "tool_call.content",
            "tool_call.raw_input",
            "tool_call.raw_output",
            "tool_call.meta_data",
            "runtime_config_revision.payload",
            "task.command_text",
            "task.intention",
            "task.output",
            "agent.prompt",
            "agent.tool_list",
            "email_message.content",
            "checklist_step.content",
            "execution_resume_task.error_reason",
            "chat_turn.error_reason");

    /** 自增主键表（PO 侧 {@code IdType.AUTO}）；其余表主键由应用生成。 */
    private static final Set<String> IDENTITY_TABLES = Set.of(
            "mcp", "provider_config", "model_config", "workspace", "session", "agent", "team", "execution",
            "execution_resume_task");

    private static final Pattern CREATE_TABLE = Pattern.compile(
            "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s*\\(([\\s\\S]*?)\\n\\);",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern UNIQUE_INDEX = Pattern.compile(
            "CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s+ON\\s+(\\w+)\\s*\\(([^)]*)\\)",
            Pattern.CASE_INSENSITIVE);

    /** 表级约束行：首词是这些关键字时整行跳过，否则 CHECKLIST_ID 会被当成 CHECK。 */
    private static final Pattern TABLE_CONSTRAINT = Pattern.compile(
            "^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\\b", Pattern.CASE_INSENSITIVE);

    private final List<H2TestDatabase> databases = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (H2TestDatabase database : databases) {
            database.shutdown();
        }
        databases.clear();
    }

    @Test
    @DisplayName("PO 字段 ⊆ H2 基线列；基线声明的表集合 = 初始化器期望清单")
    void everyPoFieldExistsInH2Schema() throws IOException {
        Map<String, Set<String>> ddl = loadSchema();
        assertEquals(new LinkedHashSet<>(H2SchemaInitializer.expectedTables()), new LinkedHashSet<>(ddl.keySet()),
                "初始化器的期望表清单必须与基线脚本一致");

        List<String> violations = new ArrayList<>();
        for (Class<?> po : PO_CLASSES) {
            String table = tableNameOf(po);
            Set<String> columns = ddl.get(table);
            if (columns == null) {
                violations.add(po.getSimpleName() + " -> 表 `" + table + "` 在 H2 基线里不存在");
                continue;
            }
            for (Map.Entry<String, String> entry : persistentColumns(po).entrySet()) {
                if (!columns.contains(entry.getValue().toLowerCase(Locale.ROOT))) {
                    violations.add(po.getSimpleName() + " 的字段 `" + entry.getKey()
                            + "`(映射列 `" + entry.getValue() + "`) 在表 `" + table + "` 中无对应列");
                }
            }
        }
        if (!violations.isEmpty()) {
            fail("发现 " + violations.size() + " 个 PO↔H2 DDL 不一致（db/h2 脚本是 H2 侧唯一事实来源）:\n  - "
                    + String.join("\n  - ", violations));
        }
    }

    @Test
    @DisplayName("大文本列在真实 H2 库上必须是 CHARACTER LARGE OBJECT（TEXT/裸 VARCHAR 会退化成 10 亿字符 VARCHAR）")
    void largeTextColumnsAreRealClob() {
        H2TestDatabase database = newDatabase("clob");
        Set<String> actual = new LinkedHashSet<>(database.queryColumn(
                "SELECT LOWER(TABLE_NAME) || '.' || LOWER(COLUMN_NAME) FROM INFORMATION_SCHEMA.COLUMNS"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC' AND DATA_TYPE = 'CHARACTER LARGE OBJECT'"
                        + " ORDER BY TABLE_NAME, COLUMN_NAME"));
        assertEquals(new LinkedHashSet<>(LARGE_TEXT_COLUMNS), actual,
                "CLOB 列集合必须与附录 A.2 完全一致（少一列=大文本会进内存 VARCHAR，多一列=有界列被误当大文本）");
    }

    @Test
    @DisplayName("自动时间列：16 张 touch 表必须带 ON UPDATE，checklist/checklist_step 不带（与 SQLite 无触发器一致）")
    void automaticTouchColumnsMatchSqliteTriggers() {
        H2TestDatabase database = newDatabase("on-update");
        List<String> missing = database.queryColumn(
                "SELECT TABLE_NAME || '.' || COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC'"
                        + " AND COLUMN_NAME IN ('UPDATE_TIME', 'UPDATED_AT', 'UPDATE_AT')"
                        + " AND COLUMN_ON_UPDATE IS NULL ORDER BY TABLE_NAME, COLUMN_NAME");
        assertEquals(List.of("CHECKLIST.UPDATE_AT", "CHECKLIST_STEP.UPDATE_AT"), missing,
                "只有 checklist/checklist_step 的 update_at 由仓储显式写（SQLite 侧也没有触发器），其余必须带 ON UPDATE");

        assertEquals("16", database.queryString(
                        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'PUBLIC'"
                                + " AND COLUMN_NAME IN ('UPDATE_TIME', 'UPDATED_AT', 'UPDATE_AT')"
                                + " AND CAST(COLUMN_ON_UPDATE AS VARCHAR) = 'CURRENT_TIMESTAMP'"),
                "16 张带 SQLite touch 触发器的表必须有等价的 ON UPDATE（少一张就是「H2 上时间不前进」）");
    }

    @Test
    @DisplayName("时间列一律 TIMESTAMP(3)；context_ratio 必须 DOUBLE PRECISION")
    void timeAndRatioColumnTypesAreFixed() {
        H2TestDatabase database = newDatabase("types");
        List<String> badTimeColumns = database.queryColumn(
                "SELECT TABLE_NAME || '.' || COLUMN_NAME || ':' || DATA_TYPE || '('"
                        + " || COALESCE(CAST(DATETIME_PRECISION AS VARCHAR), 'null') || ')'"
                        + " FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'PUBLIC'"
                        + " AND (COLUMN_NAME LIKE '%\\_TIME' ESCAPE '\\' OR COLUMN_NAME LIKE '%\\_AT' ESCAPE '\\')"
                        + " AND (DATA_TYPE <> 'TIMESTAMP' OR DATETIME_PRECISION <> 3)");
        assertTrue(badTimeColumns.isEmpty(),
                "所有时间列必须是 TIMESTAMP(3)（毫秒、UTC 墙钟），不符的列=" + badTimeColumns);

        assertEquals("DOUBLE PRECISION", database.queryString(
                        "SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS"
                                + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = 'SESSION'"
                                + " AND COLUMN_NAME = 'CONTEXT_RATIO'"),
                "context_ratio 必须是 DOUBLE PRECISION：裸 NUMERIC 会退化成整数，NUMERIC(6,4) 会把真实占比截断");
    }

    @Test
    @DisplayName("context_ratio 走 PO + Mapper 往返：0.09512015503875969 逐字不变（NUMERIC(6,4) 会截成 0.0951）")
    void contextRatioSurvivesPoRoundTripWithoutTruncation() {
        H2TestDatabase database = newDatabase("ratio");
        BigDecimal ratio = new BigDecimal("0.09512015503875969");
        long sessionId;
        try (SqlSession session = sessionFactory(database).openSession(true)) {
            SessionMapper mapper = session.getMapper(SessionMapper.class);
            SessionPO po = SessionPO.builder()
                    .name("ratio-round-trip")
                    .contextRatio(ratio)
                    .build();
            assertEquals(1, mapper.insert(po), "写入会话行必须成功");
            sessionId = po.getId();
            SessionPO loaded = mapper.selectById(sessionId);
            assertEquals(ratio.toPlainString(), loaded.getContextRatio().toPlainString(),
                    "经 PO 读回的占比必须逐字等于写入值（等于 0.0951 就说明列是定点数）");
            assertEquals(ratio.doubleValue(), loaded.getContextRatio().doubleValue(), 0.0d,
                    "值必须与领域模型的 double 完全一致");
        }
    }

    @Test
    @DisplayName("唯一索引（名字 + 列序）与基线脚本一致；生成列与 identity 形态固定")
    void uniqueIndexesAndGeneratedColumnsAreFixed() throws IOException {
        H2TestDatabase database = newDatabase("indexes");
        Map<String, List<String>> expected = uniqueIndexesOfScript();
        assertTrue(expected.size() >= 10, "基线里的唯一索引数量异常: " + expected.keySet());
        for (Map.Entry<String, List<String>> entry : expected.entrySet()) {
            List<String> actual = database.queryColumn(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.INDEX_COLUMNS WHERE UPPER(INDEX_NAME) = '"
                            + entry.getKey() + "' ORDER BY ORDINAL_POSITION");
            assertEquals(entry.getValue(), actual,
                    "唯一索引 " + entry.getKey() + " 的列序必须与脚本一致（顺序变了唯一性语义就变了）");
        }

        assertEquals("ALWAYS", database.queryString(
                        "SELECT IS_GENERATED FROM INFORMATION_SCHEMA.COLUMNS"
                                + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = 'CHECKLIST'"
                                + " AND COLUMN_NAME = 'ACTIVE_SESSION_KEY'"),
                "active_session_key 必须是生成列（「每会话至多一份活动清单」由它在库侧保证）");

        Set<String> identityTables = new LinkedHashSet<>(database.queryColumn(
                "SELECT LOWER(TABLE_NAME) FROM INFORMATION_SCHEMA.COLUMNS"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC' AND COLUMN_NAME = 'ID' AND IS_IDENTITY = 'YES'"
                        + " ORDER BY TABLE_NAME"));
        assertEquals(IDENTITY_TABLES, identityTables,
                "自增表集合必须与 PO 的 IdType.AUTO 完全一致");
    }

    /** 开一个已建库、类型处理器走生产代码（{@code MyBatisTypeHandlers.registerAll(config, H2)}）的会话工厂。 */
    private SqlSessionFactory sessionFactory(H2TestDatabase database) {
        return database.sessionFactory(SessionMapper.class);
    }

    private H2TestDatabase newDatabase(String prefix) {
        H2TestDatabase database = H2TestDatabase.create(prefix);
        databases.add(database);
        return database;
    }

    /** 从脚本里解析唯一索引 → 列序（去掉 DESC 之类的排序修饰）。 */
    private Map<String, List<String>> uniqueIndexesOfScript() throws IOException {
        Map<String, List<String>> indexes = new LinkedHashMap<>();
        Matcher matcher = UNIQUE_INDEX.matcher(Files.readString(locateScript(), StandardCharsets.UTF_8));
        while (matcher.find()) {
            List<String> columns = new ArrayList<>();
            for (String raw : matcher.group(3).split(",")) {
                columns.add(raw.strip().split("\\s+")[0].toUpperCase(Locale.ROOT));
            }
            indexes.put(matcher.group(1).toUpperCase(Locale.ROOT), columns);
        }
        return indexes;
    }

    /** 按版本合并建表与补列脚本，核对最终结构。 */
    private static Map<String, Set<String>> loadSchema() throws IOException {
        Map<String, Set<String>> tables = new LinkedHashMap<>();
        Pattern addColumn = Pattern.compile("ALTER\\s+TABLE\\s+(\\w+)\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+(\\w+)", Pattern.CASE_INSENSITIVE);
        for (SchemaScript script : new H2SchemaInitializer().loadScripts()) {
            Matcher matcher = CREATE_TABLE.matcher(script.content());
            while (matcher.find()) {
                tables.put(matcher.group(1).toLowerCase(Locale.ROOT), parseColumns(matcher.group(2)));
            }
            Matcher added = addColumn.matcher(script.content());
            while (added.find()) {
                Set<String> columns = tables.get(added.group(1).toLowerCase(Locale.ROOT));
                assertTrue(columns != null, "补列脚本引用的表必须存在");
                columns.add(added.group(2).toLowerCase(Locale.ROOT));
            }
        }
        assertTrue(tables.size() >= 20, "基线应至少解析出 20 张表，实际=" + tables.keySet());
        return tables;
    }

    private static Set<String> parseColumns(String body) {
        Set<String> columns = new LinkedHashSet<>();
        for (String rawLine : body.split("\n")) {
            String line = rawLine.strip();
            if (line.isEmpty() || line.startsWith("--")) {
                continue;
            }
            if (line.startsWith("(") || TABLE_CONSTRAINT.matcher(line.toUpperCase(Locale.ROOT)).find()) {
                continue;
            }
            String name = line.split("[\\s(]+", 2)[0].replace("`", "").trim();
            if (!name.isEmpty()) {
                columns.add(name.toLowerCase(Locale.ROOT));
            }
        }
        return columns;
    }

    private static Map<String, String> persistentColumns(Class<?> poClass) {
        Map<String, String> fields = new LinkedHashMap<>();
        for (Field field : poClass.getDeclaredFields()) {
            int modifiers = field.getModifiers();
            if (Modifier.isStatic(modifiers) || Modifier.isTransient(modifiers) || field.isSynthetic()) {
                continue;
            }
            TableField tableField = field.getAnnotation(TableField.class);
            if (tableField != null) {
                if (!tableField.exist()) {
                    continue;
                }
                String explicit = tableField.value();
                if (explicit != null && !explicit.isBlank()) {
                    fields.put(field.getName(), explicit.replace("`", "").trim());
                    continue;
                }
            }
            fields.put(field.getName(), camelToSnake(field.getName()));
        }
        return fields;
    }

    private static String tableNameOf(Class<?> poClass) {
        TableName tableName = poClass.getAnnotation(TableName.class);
        if (tableName != null && !tableName.value().isBlank()) {
            return tableName.value().trim().toLowerCase(Locale.ROOT);
        }
        return camelToSnake(poClass.getSimpleName()).toLowerCase(Locale.ROOT);
    }

    private static String camelToSnake(String camel) {
        StringBuilder builder = new StringBuilder(camel.length() + 4);
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    builder.append('_');
                }
                builder.append(Character.toLowerCase(c));
            } else {
                builder.append(c);
            }
        }
        return builder.toString();
    }

    /** 定位 H2 基线脚本：从 user.dir 逐级向上找 {@code src/main/resources/db/h2}。 */
    private static Path locateScript() throws IOException {
        List<Path> candidates = new ArrayList<>();
        String userDir = System.getProperty("user.dir");
        if (userDir != null && !userDir.isBlank()) {
            Path dir = Paths.get(userDir).toAbsolutePath();
            for (int i = 0; i < 4 && dir != null; i++, dir = dir.getParent()) {
                candidates.add(dir.resolve("src/main/resources/db/h2"));
            }
        }
        candidates.add(Paths.get("src/main/resources/db/h2").toAbsolutePath());
        for (Path candidate : candidates) {
            if (!Files.isDirectory(candidate)) {
                continue;
            }
            try (Stream<Path> paths = Files.list(candidate)) {
                Path script = paths
                        .filter(path -> path.getFileName().toString().matches("V\\d+__.*\\.sql"))
                        .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                        .findFirst()
                        .orElse(null);
                if (script != null) {
                    return script;
                }
            }
        }
        throw new IllegalStateException("未找到 H2 建库脚本，候选目录=" + candidates);
    }
}

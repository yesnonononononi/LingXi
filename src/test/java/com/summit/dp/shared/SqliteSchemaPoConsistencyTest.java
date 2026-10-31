package com.summit.dp.shared;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * DDL ↔ PO 一致性守卫。
 *
 * <p><b>为什么需要它：</b>历史缺陷是「单测自建 schema，掩盖了真库 DDL 与 PO 的差异」，
 * 于是 {@code PO 有字段、建表脚本无对应列}这类孤儿字段只在真库上爆炸
 * （MyBatis-Plus 生成 {@code SELECT ... unknown_col ...} → 接口 500），而 {@code mvn test} 依旧全绿。
 * 现在建表脚本只有一个真源（{@code db/sqlite/V*__*.sql}），本测试在纯 JVM 内断言
 * 「每个持久化 PO 的字段集合 ⊆ 该表在建表脚本中的列集合」。</p>
 *
 * <p><b>取舍：</b>不使用 MyBatis-Plus {@code TableInfoHelper}（要先起 Spring/MyBatis 上下文，
 * 会把测试变成重容器用例），改用「正则解析脚本 + 反射读 PO」。
 * 映射规则与 MyBatis-Plus 默认约定一致：camelCase → snake_case，
 * 显式 {@code @TableField("col")} 以其值为准（{@code exist=false} 视为非持久化），
 * {@code @TableId} 视作普通持久化列。</p>
 */
class SqliteSchemaPoConsistencyTest {

    /** 全部持久化 PO；新增 PO 必须登记到这里，否则本守卫覆盖不到它。 */
    private static final List<Class<?>> PO_CLASSES = List.of(
            com.summit.dp.session.infrastructure.persistence.po.SessionPO.class,
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

    /** 捕获 {@code CREATE TABLE <name> ( ... );} 块；DOTALL 让列定义可跨行。 */
    private static final Pattern CREATE_TABLE = Pattern.compile(
            "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)\\s*\\(([\\s\\S]*?)\\n\\);",
            Pattern.CASE_INSENSITIVE);

    /** 表级约束行：首词是这些关键字时必须按词边界匹配，否则 CHECKLIST_ID 会被当成 CHECK。 */
    private static final Pattern TABLE_CONSTRAINT = Pattern.compile(
            "^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\\b", Pattern.CASE_INSENSITIVE);

    @Test
    @DisplayName("每个持久化 PO 的字段都必须在 SQLite 建表脚本的对应表中存在同名列")
    void everyPoFieldExistsInSqliteSchema() throws IOException {
        Map<String, Set<String>> ddl = loadSchema();
        assertTrue(ddl.size() >= 19,
                "建表脚本应至少解析出 19 张业务表，实际解析到 " + ddl.size() + " 张: " + ddl.keySet());

        List<String> violations = new ArrayList<>();
        for (Class<?> po : PO_CLASSES) {
            String table = tableNameOf(po);
            Set<String> columns = ddl.get(table);
            if (columns == null) {
                violations.add(po.getSimpleName() + " -> 表 `" + table + "` 在建表脚本中不存在");
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
            fail("发现 " + violations.size() + " 个 PO↔DDL 不一致（db/sqlite 脚本是唯一事实来源）:\n  - "
                    + String.join("\n  - ", violations));
        }
    }

    /** 解析全部版本脚本，返回「表名(小写) → 列名集合(小写)」。 */
    private static Map<String, Set<String>> loadSchema() throws IOException {
        Map<String, Set<String>> tables = new LinkedHashMap<>();
        for (Path script : locateScripts()) {
            String sql = Files.readString(script, StandardCharsets.UTF_8);
            Matcher matcher = CREATE_TABLE.matcher(sql);
            while (matcher.find()) {
                tables.put(matcher.group(1).toLowerCase(Locale.ROOT), parseColumns(matcher.group(2)));
            }
        }
        return tables;
    }

    /** 从 CREATE TABLE 主体中抽取列名；跳过表级约束/索引与注释行。 */
    private static Set<String> parseColumns(String body) {
        Set<String> columns = new LinkedHashSet<>();
        for (String rawLine : body.split("\n")) {
            String line = rawLine.strip();
            if (line.isEmpty() || line.startsWith("--")) {
                continue;
            }
            // 表级约束/索引整行跳过；判定必须带词边界：CHECKLIST_ID 曾因 startsWith("CHECK") 被误判成约束行，
            // 于是 checklist_step.checklist_id 在整个断言里凭空消失（列真在，解析器看不见）。
            if (line.startsWith("(") || TABLE_CONSTRAINT.matcher(line.toUpperCase(Locale.ROOT)).find()) {
                continue;
            }
            // 列名取该行第一个 token（列定义形如 "col TYPE ..."）
            String name = line.split("[\\s(]+", 2)[0].replace("`", "").trim();
            if (!name.isEmpty()) {
                columns.add(name.toLowerCase(Locale.ROOT));
            }
        }
        return columns;
    }

    /** 反射读取 PO 的持久化字段：排除 static / transient / synthetic 与 {@code @TableField(exist=false)}。 */
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
                    // 反引号只用于躲 jsqlparser 关键字（如 `output`），列身份与裸名相同。
                    fields.put(field.getName(), explicit.replace("`", "").trim());
                    continue;
                }
            }
            fields.put(field.getName(), camelToSnake(field.getName()));
        }
        return fields;
    }

    /** 取 {@code @TableName} 声明的表名；缺省回落到类名 snake_case（与 MyBatis-Plus 默认一致）。 */
    private static String tableNameOf(Class<?> poClass) {
        TableName tableName = poClass.getAnnotation(TableName.class);
        if (tableName != null && !tableName.value().isBlank()) {
            return tableName.value().trim().toLowerCase(Locale.ROOT);
        }
        return camelToSnake(poClass.getSimpleName()).toLowerCase(Locale.ROOT);
    }

    /** camelCase → snake_case（与 MyBatis-Plus TableInfoHelper 默认 tableUnderline=true 一致）。 */
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

    /** 定位建表脚本目录：优先 user.dir 向上回溯，其次当前工作目录。 */
    private static List<Path> locateScripts() throws IOException {
        List<Path> candidates = new ArrayList<>();
        String userDir = System.getProperty("user.dir");
        if (userDir != null && !userDir.isBlank()) {
            Path dir = Paths.get(userDir).toAbsolutePath();
            for (int i = 0; i < 4 && dir != null; i++, dir = dir.getParent()) {
                candidates.add(dir.resolve("src/main/resources/db/sqlite"));
            }
        }
        candidates.add(Paths.get("src/main/resources/db/sqlite").toAbsolutePath());
        for (Path candidate : candidates) {
            if (!Files.isDirectory(candidate)) {
                continue;
            }
            try (Stream<Path> paths = Files.list(candidate)) {
                List<Path> scripts = paths
                        .filter(path -> path.getFileName().toString().matches("V\\d+__.*\\.sql"))
                        .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                        .toList();
                if (!scripts.isEmpty()) {
                    return scripts;
                }
            }
        }
        throw new IllegalStateException("未找到 SQLite 建表脚本，候选目录=" + candidates);
    }
}

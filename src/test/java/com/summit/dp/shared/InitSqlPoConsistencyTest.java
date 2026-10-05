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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * DDL ↔ PO 一致性守卫（防复发）。
 *
 * <p><b>为什么需要它：</b>本轮回归根因是「单测用 H2 自建 schema，掩盖了真库 DDL 与 PO 的差异」，
 * 使得 {@code SessionPO.status}、{@code SessionMessagePO.requestId}/{@code completed} 这类
 * 「PO 有字段、{@code init.sql} 无对应列」的孤儿字段只在真库上爆炸
 * （MyBatis-Plus 生成 {@code SELECT ... unknown_col ...} → {@code Unknown column} → 接口 500），
 * 而 {@code mvn test} 依旧全绿。本测试把 {@code init.sql} 当作唯一事实来源，
 * 在纯 JVM（无 Spring 容器）内断言
 * 「每个持久化 PO 的字段集合 ⊆ 该表在 init.sql 中的列集合」，
 * 从而把这类缺陷前移到编译/测试阶段。</p>
 *
 * <p><b>取舍：</b>不使用 MyBatis-Plus {@code TableInfoHelper}（需先初始化 Spring/MyBatis 上下文，
 * 会把测试变成重容器用例），改用「正则解析 init.sql + 反射读 PO」。
 * 映射规则与 MyBatis-Plus 默认约定保持一致：camelCase → snake_case，
 * 显式 {@code @TableField("col")} 以其值为准（{@code exist=false} 视为非持久化），
 * {@code @TableId} 视作普通持久化列。</p>
 */
class InitSqlPoConsistencyTest {

    /** 本次改造涉及的全部业务 PO（13 张表）。agent_mail / users 为历史遗留表、无 PO，不在此列。 */
    private static final List<Class<?>> PO_CLASSES = List.of(
            com.summit.dp.session.infrastructure.persistence.po.SessionPO.class,
            com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO.class,
            com.summit.dp.session.infrastructure.persistence.po.SessionContextPO.class,
            com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO.class,
            com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO.class,
            com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO.class,
            com.summit.dp.workspace.infrastructure.persistence.po.WorkspacePO.class,
            com.summit.dp.agent.infrastructure.persistence.po.AgentPO.class,
            com.summit.dp.team.infrastructure.persistence.po.TeamPO.class,
            com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO.class,
            com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO.class,
            com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO.class,
            com.summit.dp.email.infrastructure.persistence.po.EmailPO.class,
            com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO.class,
            com.summit.dp.mcp.infrastructure.persistence.po.McpPO.class);

    /** 捕获 {@code CREATE TABLE <name> ( ... ) ENGINE ...} 块；DOTALL 让列定义可跨行。 */
    private static final Pattern CREATE_TABLE = Pattern.compile(
            "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`?(\\w+)`?\\s*\\((.*?)\\)\\s*ENGINE",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    @Test
    @DisplayName("每个持久化 PO 的字段都必须在 init.sql 对应表中存在同名列")
    void everyPoFieldExistsInInitSql() throws IOException {
        Map<String, Set<String>> ddl = loadInitSql();
        assertTrue(ddl.size() >= 9,
                "init.sql 应至少解析出 9 张业务表，实际解析到 " + ddl.size() + " 张: " + ddl.keySet());

        List<String> violations = new ArrayList<>();
        for (Class<?> po : PO_CLASSES) {
            String table = tableNameOf(po);
            Set<String> columns = ddl.get(table);
            if (columns == null) {
                violations.add(po.getSimpleName() + " -> 表 `" + table + "` 在 init.sql 中不存在");
                continue;
            }
            for (Map.Entry<String, String> e : persistentColumns(po).entrySet()) {
                if (!columns.contains(e.getValue().toLowerCase(Locale.ROOT))) {
                    violations.add(po.getSimpleName() + " 的字段 `" + e.getKey()
                            + "`(映射列 `" + e.getValue() + "`) 在表 `" + table + "` 中无对应列");
                }
            }
        }
        if (!violations.isEmpty()) {
            fail("发现 " + violations.size() + " 个 PO↔DDL 不一致（init.sql 是唯一事实来源）:\n  - "
                    + String.join("\n  - ", violations));
        }
    }

    /** 解析仓库根 init.sql，返回「表名(小写) → 列名集合(小写)」。 */
    private static Map<String, Set<String>> loadInitSql() throws IOException {
        Path initSql = locateInitSql();
        String sql = Files.readString(initSql, StandardCharsets.UTF_8);
        Map<String, Set<String>> tables = new LinkedHashMap<>();
        Matcher matcher = CREATE_TABLE.matcher(sql);
        while (matcher.find()) {
            tables.put(matcher.group(1).toLowerCase(Locale.ROOT), parseColumns(matcher.group(2)));
        }
        return tables;
    }

    /** 从 CREATE TABLE 主体中抽取列名；跳过表级约束/索引（KEY/UNIQUE/CONSTRAINT/...）与注释行。 */
    private static Set<String> parseColumns(String body) {
        Set<String> columns = new LinkedHashSet<>();
        for (String rawLine : body.split("\n")) {
            String line = rawLine.strip();
            if (line.isEmpty() || line.startsWith("--")) {
                continue;
            }
            String upper = line.toUpperCase(Locale.ROOT);
            if (upper.startsWith("PRIMARY") || upper.startsWith("UNIQUE") || upper.startsWith("KEY")
                    || upper.startsWith("INDEX") || upper.startsWith("CONSTRAINT")
                    || upper.startsWith("FOREIGN") || upper.startsWith("CHECK")
                    || upper.startsWith("(")) {
                continue;
            }
            // 列名取该行第一个 token（列定义形如 "col TYPE ..."，类型与注释在同行）
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
                    fields.put(field.getName(), explicit.trim());
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
        StringBuilder sb = new StringBuilder(camel.length() + 4);
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    sb.append('_');
                }
                sb.append(Character.toLowerCase(c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** 定位仓库根 init.sql：优先 user.dir 向上回溯，其次当前工作目录。 */
    private static Path locateInitSql() {
        List<Path> candidates = new ArrayList<>();
        String userDir = System.getProperty("user.dir");
        if (userDir != null && !userDir.isBlank()) {
            Path dir = Paths.get(userDir).toAbsolutePath();
            for (int i = 0; i < 4 && dir != null; i++, dir = dir.getParent()) {
                candidates.add(dir.resolve("init.sql"));
            }
        }
        candidates.add(Paths.get("init.sql").toAbsolutePath());
        return candidates.stream()
                .filter(Files::exists)
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("未找到 init.sql，候选路径=" + candidates));
    }
}

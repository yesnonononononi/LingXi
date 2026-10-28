package com.summit.dp.shared;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.io.InputStream;
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
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 「改 {@code init.sql} 加列，必须同时加 {@code db/migration} 脚本」的守卫。
 *
 * <p><b>为什么必须有这条</b>：给 {@code init.sql} 加列/改宽对**已有库完全无效**
 * （{@code CREATE TABLE IF NOT EXISTS} 既不 ALTER 也不改列宽），老库只能靠迁移脚本补。
 * 漏了脚本的后果是**运行期** {@code Column "X" not found}，而新库与单测全绿 ——
 * 这类缺陷在本仓已出现过 4 次（团队描述列宽、{@code email_message.dedup_key}、
 * agent/team 头像、以及 V8 一次性结清的 16 列），每次都靠人记得，所以这里立一条绊线。</p>
 *
 * <p><b>判据</b>：以 {@code init-sql-columns-frozen.txt} 的冻结清单为基线，
 * 凡「当前 init.sql 有、基线里没有、且该表在基线里已存在」的列，都必须在迁移目录里被显式添加。
 * 基线刻意不随加列更新 —— 它存在的意义就是让新加的列无处躲藏。</p>
 */
class InitSqlMigrationCoverageTest {

    /** 冻结清单：见该文件头部说明。加列时**不要**同步更新它，否则本用例形同虚设。 */
    private static final String FROZEN_MANIFEST = "init-sql-columns-frozen.txt";

    /** 捕获 {@code CREATE TABLE <name> ( ... ) ENGINE ...}；DOTALL 让列定义可跨行。 */
    private static final Pattern CREATE_TABLE = Pattern.compile(
            "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`?(\\w+)`?\\s*\\((.*?)\\)\\s*ENGINE",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    /**
     * 列定义 {@code col TYPE ...}。判据必须是「**第二个 token 是类型**」，不能只看「首 token 不像关键字」：
     * {@code chat_turn.status} 的 ENUM 定义跨了两行，续行以 {@code COMMENT} 开头，
     * 只看首 token 会凭空造出一个 {@code comment} 列（本测试初版就踩了这个）。
     */
    private static final Pattern COLUMN_DEFINITION = Pattern.compile(
            "^\\s*`?(\\w+)`?\\s+(BIGINT|VARCHAR|INT|TEXT|LONGTEXT|ENUM|DATETIME|TINYINT|CLOB"
                    + "|DECIMAL|BOOLEAN|TIMESTAMP)\\b",
            Pattern.CASE_INSENSITIVE);

    /**
     * V7 + V8 已结清的历史欠账。列在这里有两个作用：
     * ① 本用例今天不是空跑（真去迁移目录里找这 17 列的脚本）；
     * ② 谁把 V7/V8 的脚本误删，这里先红。
     */
    private static final List<String> SETTLED_DEBT = List.of(
            "email_message.dedup_key",
            "mcp.command", "session.agent_id",
            "session.context_token_count", "session.context_max_tokens",
            "session.context_ratio", "session_message.turn_id",
            "mcp.headers", "mcp.env",
            "tool_call.content", "tool_call.raw_input",
            "tool_call.raw_output", "tool_call.meta_data",
            "user_configs.render_theme", "user_configs.data_dir",
            "user_configs.skill_dir", "user_configs.team_size");

    @Test
    @DisplayName("init.sql 每张已存在表新加的列，都必须在 db/migration 里有对应迁移")
    void everyColumnAddedAfterItsTableWasCreatedHasAMigration() throws IOException {
        Map<String, Set<String>> current = parseInitSql(Files.readString(locateInitSql(), StandardCharsets.UTF_8));
        Map<String, Set<String>> manifest = readManifest();

        // 金丝雀 1：解析器真能读到列（否则下面的「没有差异」可能是「什么都没解析出来」的假绿）
        assertTrue(current.size() >= 9, "init.sql 应至少解析出 9 张表，实际 " + current.size());
        assertTrue(current.getOrDefault("email_message", Set.of()).contains("dedup_key"),
                "解析器有效性对照：应当解析出 email_message.dedup_key");
        assertTrue(current.getOrDefault("chat_turn", Set.of()).contains("total_token_count"),
                "解析器有效性对照：应当解析出 chat_turn.total_token_count");
        assertFalse(current.getOrDefault("chat_turn", Set.of()).contains("comment"),
                "ENUM 跨行续行（以 COMMENT 开头）不得被当成列名");
        // 金丝雀 2：冻结清单确实被读到了
        assertTrue(manifest.size() >= 9, "冻结清单应至少含 9 张表，实际 " + manifest.size());

        Map<String, String> migrations = readMigrations();
        assertTrue(migrations.size() >= 10, "迁移目录应有脚本，实际 " + migrations.size());

        List<String> violations = new ArrayList<>();
        for (Map.Entry<String, Set<String>> table : current.entrySet()) {
            // 基线里没有这张表 = 表是新建的：init.sql 会整表建出来，不涉及「老库缺列」
            if (!manifest.containsKey(table.getKey())) {
                continue;
            }
            for (String column : table.getValue()) {
                if (manifest.get(table.getKey()).contains(column)) {
                    continue;
                }
                if (!hasMigrationFor(migrations, table.getKey(), column)) {
                    violations.add(table.getKey() + "." + column);
                }
            }
        }
        if (!violations.isEmpty()) {
            fail("这些列加进了 init.sql 却没有 db/migration 脚本，老库升上来会在运行期"
                    + "报 Column \"X\" not found：\n  - " + String.join("\n  - ", violations)
                    + "\n请新增 db/migration/V<n>_<表>_<列>.sql（逐列 ALTER + hasColumn 判定），"
                    + "并在 H2SchemaInitializer 里挂上 migrateV<n>。");
        }

        // 已结清的欠账今天就必须有脚本；缺了说明迁移被删或改名
        List<String> missingDebt = new ArrayList<>();
        for (String entry : SETTLED_DEBT) {
            String[] parts = entry.split("\\.");
            if (!hasMigrationFor(migrations, parts[0], parts[1])) {
                missingDebt.add(entry);
            }
        }
        assertTrue(missingDebt.isEmpty(),
                "V7/V8 已结清的列找不到迁移脚本（迁移被删或改名了？）：" + String.join(", ", missingDebt));
    }

    /**
     * 某列是否被迁移覆盖：文件名按本仓约定 {@code V<n>_<表>_<列>.sql} 命中，
     * 或任一脚本正文里有 {@code ADD COLUMN <列>}。两者取或 —— 后者兜住「一个脚本批量补多列」的写法。
     */
    private boolean hasMigrationFor(Map<String, String> migrations, String table, String column) {
        String suffix = "_" + table + "_" + column + ".sql";
        Pattern addColumn = Pattern.compile(
                "(?i)add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?`?"
                        + Pattern.quote(column) + "`?\\b");
        for (Map.Entry<String, String> migration : migrations.entrySet()) {
            if (migration.getKey().toLowerCase(Locale.ROOT).endsWith(suffix)) {
                return true;
            }
            if (addColumn.matcher(migration.getValue()).find()) {
                return true;
            }
        }
        return false;
    }

    @Test
    void recognizesIdempotentColumnAdditionWithoutRenamingTheMigration() {
        Map<String, String> migrations = Map.of("V15_session_read.sql",
                "ALTER TABLE session ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT TRUE;");
        assertTrue(hasMigrationFor(migrations, "session", "is_read"));
        assertFalse(hasMigrationFor(Map.of("V15_session_read.sql", "SELECT is_read FROM session;"),
                "session", "is_read"));
    }

    /** 迁移目录里所有脚本：文件名(小写) → 正文。 */
    private Map<String, String> readMigrations() throws IOException {
        Path directory = locateRepoRoot().resolve("src/main/resources/db/migration");
        assertTrue(Files.isDirectory(directory), "迁移目录不存在: " + directory);
        Map<String, String> migrations = new LinkedHashMap<>();
        try (Stream<Path> files = Files.list(directory)) {
            for (Path file : files.filter(p -> p.getFileName().toString().endsWith(".sql")).sorted().toList()) {
                migrations.put(file.getFileName().toString().toLowerCase(Locale.ROOT),
                        Files.readString(file, StandardCharsets.UTF_8));
            }
        }
        return migrations;
    }

    /** 冻结清单：{@code 表.列} 每行一条，{@code #} 开头为注释。 */
    private Map<String, Set<String>> readManifest() throws IOException {
        ClassPathResource resource = new ClassPathResource(FROZEN_MANIFEST);
        Map<String, Set<String>> manifest = new LinkedHashMap<>();
        try (InputStream in = resource.getInputStream()) {
            for (String rawLine : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                String line = rawLine.strip();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                String[] parts = line.split("\\.", 2);
                manifest.computeIfAbsent(parts[0].toLowerCase(Locale.ROOT), key -> new LinkedHashSet<>())
                        .add(parts[1].toLowerCase(Locale.ROOT));
            }
        }
        return manifest;
    }

    private Map<String, Set<String>> parseInitSql(String sql) {
        Map<String, Set<String>> tables = new LinkedHashMap<>();
        Matcher matcher = CREATE_TABLE.matcher(sql);
        while (matcher.find()) {
            tables.put(matcher.group(1).toLowerCase(Locale.ROOT), parseColumns(matcher.group(2)));
        }
        return tables;
    }

    /** 从 CREATE TABLE 主体抽列名；跳过表级约束/索引行与注释行。 */
    private Set<String> parseColumns(String body) {
        Set<String> columns = new LinkedHashSet<>();
        for (String line : body.split("\n")) {
            Matcher matcher = COLUMN_DEFINITION.matcher(line);
            if (matcher.find()) {
                columns.add(matcher.group(1).toLowerCase(Locale.ROOT));
            }
        }
        return columns;
    }

    private Path locateInitSql() {
        return locateRepoRoot().resolve("init.sql");
    }

    /** 定位仓库根：从 user.dir 向上回溯找同时有 init.sql 与 src/main/resources 的目录。 */
    private Path locateRepoRoot() {
        Path directory = Paths.get("").toAbsolutePath();
        while (directory != null) {
            if (Files.exists(directory.resolve("init.sql"))
                    && Files.isDirectory(directory.resolve("src/main/resources"))) {
                return directory;
            }
            directory = directory.getParent();
        }
        throw new IllegalStateException("未找到仓库根（含 init.sql 与 src/main/resources），cwd="
                + Paths.get("").toAbsolutePath());
    }
}

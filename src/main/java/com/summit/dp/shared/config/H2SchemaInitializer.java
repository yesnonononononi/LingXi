package com.summit.dp.shared.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.io.InputStream;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 只补缺表与缺列；迁移必须先于启动时的执行收口。 */
@Slf4j
@Configuration
public class H2SchemaInitializer {

    /** classpath 上的 init.sql（构建期由 maven-resources-plugin 从仓库根打入） */
    private static final String INIT_SQL = "init.sql";

    /**
     * 团队描述列宽上限：与 {@code Team.MAX_DESCRIPTION_LENGTH} 及 init.sql 的列宽三处一致。
     *
     * <p>刻意不 import 领域常量 —— 本类在 shared 层，不该反向依赖 team 域；代价是改上限时要三处同步，
     * 这条注释就是那个提醒。</p>
     */
    private static final int TEAM_DESCRIPTION_MAX_LENGTH = 1000;

    private static final Pattern CREATE_TABLE =
            Pattern.compile("(?i)create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?[`\"]?(\\w+)[`\"]?");

    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public ApplicationRunner h2SchemaBootstrap(DataSource dataSource) {
        return args -> {
            ClassPathResource script = new ClassPathResource(INIT_SQL);
            String sql = readScript(script);
            if (Pattern.compile("(?im)^\\s*(?:DROP|TRUNCATE)\\s+TABLE\\b").matcher(sql).find()) {
                throw new IllegalStateException("初始化脚本包含破坏性建表语句，已拒绝执行");
            }
            List<String> expected = parseTableNames(sql);
            try (Connection connection = dataSource.getConnection()) {
                List<String> missing = findMissingTables(connection, expected);
                if (!missing.isEmpty()) {
                    // init.sql 只允许幂等建表，旧库缺新表不能触发重建。
                    ScriptUtils.executeSqlScript(
                            connection, new EncodedResource(script, StandardCharsets.UTF_8));
                    log.info("补齐业务表: missing={}", missing);
                }
                migrateToolCall(connection);
                migrateStream(connection);
                migrateV3(connection);
                migrateV4(connection);
                migrateV5(connection);
                migrateV6(connection);
                migrateV7(connection);
                migrateV8(connection);
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V9_task_intention.sql"), StandardCharsets.UTF_8));
                migrateV10(connection);
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V11_task_execution.sql"), StandardCharsets.UTF_8));
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V12_model_config_vision.sql"), StandardCharsets.UTF_8));
                // V13：model_config 补 provider_config_id（脚本自带 IF NOT EXISTS，新库天然空操作）。
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V13_model_config_provider_config_id.sql"), StandardCharsets.UTF_8));
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V14_checklist_result_status.sql"), StandardCharsets.UTF_8));
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V15_session_read.sql"), StandardCharsets.UTF_8));
                // V16：user_configs 补 compact_model_id（专用压缩模型；脚本自带 IF NOT EXISTS，新库天然空操作）。
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V16_user_configs_compact_model_id.sql"), StandardCharsets.UTF_8));
            }
        };
    }

    /**
     * V10：task.command 改名为 command_text。
     *
     * <p>必须在启动收尸钩子之前完成：它要查 task 表，列名对不上就整条查询失败、进程直接退出。</p>
     */
    private void migrateV10(Connection connection) throws Exception {
        if (hasColumn(connection, "task", "command") && !hasColumn(connection, "task", "command_text")) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V10_task_command_text.sql"), StandardCharsets.UTF_8));
        }
    }

    /** 必须先补齐用量列，启动后的轮次查询才不会因缺列失败。 */
    private void migrateV5(Connection connection) throws Exception {
        for (String column : List.of("cache_tokens", "reasoning_tokens")) {
            if (!hasColumn(connection, "chat_turn", column)) {
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V5_chat_turn_" + column + ".sql"), StandardCharsets.UTF_8));
            }
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V5_record.sql"), StandardCharsets.UTF_8));
    }

    private String readScript(ClassPathResource script) throws Exception {
        try (InputStream in = script.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private void migrateToolCall(Connection connection) throws Exception {
        ClassPathResource migration = new ClassPathResource("db/migration/V1_tool_call_version.sql");
        boolean versionPresent = false;
        try (ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if ("tool_call".equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && "version".equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    versionPresent = true;
                }
            }
        }
        if (!versionPresent) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(migration, StandardCharsets.UTF_8));
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(
                new ClassPathResource("db/migration/V1_record.sql"), StandardCharsets.UTF_8));
    }

    private void migrateStream(Connection connection) throws Exception {
        String[][] columns = {{"session", "version"}, {"session", "history_revision"},
                {"chat_turn", "version"}, {"execution", "version"}, {"session_message", "response_id"}};
        for (String[] column : columns) {
            boolean present = false;
            try (ResultSet metadata = connection.getMetaData().getColumns(null, null, "%", "%")) {
                while (metadata.next()) {
                    if (column[0].equalsIgnoreCase(metadata.getString("TABLE_NAME"))
                            && column[1].equalsIgnoreCase(metadata.getString("COLUMN_NAME"))) present = true;
                }
            }
            if (!present) ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V2_" + column[0] + "_" + column[1] + ".sql"), StandardCharsets.UTF_8));
        }
        boolean indexPresent = false;
        try (ResultSet tables = connection.getMetaData().getTables(null, null, "%", new String[] {"TABLE"})) {
            while (tables.next()) {
                if (!"session_message".equalsIgnoreCase(tables.getString("TABLE_NAME"))) continue;
                try (ResultSet indexes = connection.getMetaData().getIndexInfo(null, null, tables.getString("TABLE_NAME"), false, false)) {
                    while (indexes.next()) {
                        String name = indexes.getString("INDEX_NAME");
                        if (name != null && name.toLowerCase(Locale.ROOT).startsWith("uk_session_response_id")) indexPresent = true;
                    }
                }
            }
        }
        if (!indexPresent) ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V2_response_id_index.sql"), StandardCharsets.UTF_8));
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V2_record.sql"), StandardCharsets.UTF_8));
    }

    /**
     * V3：命令身份、决策元信息与恢复意图。
     *
     * <p>逐列判定「缺列才 ALTER」，而不是只看 {@code lingxi_schema_version}：
     * 迁移必须对「脚本已执行但列被手工删掉」的库同样自愈。整表脚本（恢复意图表）用
     * {@code IF NOT EXISTS} 天然幂等，索引按名字判定。
     *
     * <p>必须早于启动收尸钩子：它要按 {@code resume_generation} 判定恢复任务是否过期，
     * 列还不存在就会整条查询失败。</p>
     */
    private void migrateV3(Connection connection) throws Exception {
        String[][] columns = {{"tool_call", "decision_command_id"}, {"tool_call", "decision_digest"},
                {"chat_turn", "command_id"}, {"chat_turn", "command_digest"},
                {"execution", "resume_generation"}};
        for (String[] column : columns) {
            if (!hasColumn(connection, column[0], column[1])) {
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V3_" + column[0] + "_" + column[1] + ".sql"), StandardCharsets.UTF_8));
            }
        }
        // 旧形状（带 attempts / next_attempt_at 与退避索引）已随「恢复只尝试一次」重构废弃。
        // CREATE TABLE IF NOT EXISTS 对已有旧表是空操作：死列会留下，且旧状态行
        // （EXHAUSTED / NEEDS_MANUAL / 旧语义的 FAILED）不在新收口逻辑的取值集合里，
        // 对应执行永远收不了口。恢复请求是纯瞬态标记、旧数据可全量舍弃，故检测到旧列即重建。
        if (hasColumn(connection, "execution_resume_task", "attempts")) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V3_execution_resume_task_legacy_drop.sql"), StandardCharsets.UTF_8));
            log.info("恢复请求表为旧形状，已整体重建为纯请求记录（旧请求数据按约定舍弃）");
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V3_execution_resume_task.sql"), StandardCharsets.UTF_8));
        if (!hasIndexNamed(connection, "chat_turn", "uk_chat_turn_command")) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V3_chat_turn_command_index.sql"), StandardCharsets.UTF_8));
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V3_record.sql"), StandardCharsets.UTF_8));
    }

    /**
     * V4：团队描述列宽 500 → 1000。
     *
     * <p><b>加宽列不是「缺列」</b>：{@code hasColumn} 那套判定对它无效，而 init.sql 里把
     * {@code VARCHAR(500)} 改成 {@code VARCHAR(1000)} 对**已有库完全无效** ——
     * {@code CREATE TABLE IF NOT EXISTS} 不会改已存在列的宽度。所以必须按列宽判定后显式 ALTER；
     * 只认「存在且低于目标宽度」，因此对已是 1000 的库天然幂等。</p>
     *
     * <p>先判存在再判宽度：列整个缺失时本迁移**不介入**（ALTER 会失败，那属于建列的事），
     * 保持与其它迁移一致的「只补自己的那一项」边界。</p>
     */
    private void migrateV4(Connection connection) throws Exception {
        if (hasColumn(connection, "team", "description")
                && columnSize(connection, "team", "description") < TEAM_DESCRIPTION_MAX_LENGTH) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V4_team_description.sql"), StandardCharsets.UTF_8));
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V4_record.sql"), StandardCharsets.UTF_8));
    }

    /**
     * V6：agent / team 补头像列。
     *
     * <p>加列是「缺列」，沿用 {@code hasColumn} 判定后显式 ALTER 的既有口径；
     * 新库由 init.sql 直接带上该列，迁移对它天然空操作。</p>
     */
    private void migrateV6(Connection connection) throws Exception {
        String[][] columns = {{"agent", "avatar"}, {"team", "avatar"}};
        for (String[] column : columns) {
            if (!hasColumn(connection, column[0], column[1])) {
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V6_" + column[0] + "_avatar.sql"), StandardCharsets.UTF_8));
            }
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V6_record.sql"), StandardCharsets.UTF_8));
    }

    /**
     * V7：email_message 补通知去重键（列 + 唯一索引）。
     *
     * <p>这一处的症状是「主对话一切正常，一发生协作委派就整条邮件链路报
     * {@code Column "DEDUP_KEY" not found}」：委派的子执行终结时要投一条去重通知邮件，
     * 而旧库的 email_message 建于该列之前，查询待消费消息与插入通知都会命中缺列。</p>
     *
     * <p><b>列与索引必须一起补</b>：唯一索引才是「通知只投一次」的裁决点
     * （{@code EmailServiceImpl#sendMailOnce} 靠唯一键冲突判定重复投递），
     * 只补列会让去重静默失效。顺序也不能反 —— 索引引用的列不存在时建索引会失败。</p>
     */
    private void migrateV7(Connection connection) throws Exception {
        if (!hasColumn(connection, "email_message", "dedup_key")) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V7_email_message_dedup_key.sql"), StandardCharsets.UTF_8));
        }
        if (!hasIndexNamed(connection, "email_message", "uk_email_message_dedup")) {
            ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                    "db/migration/V7_email_message_dedup_index.sql"), StandardCharsets.UTF_8));
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V7_record.sql"), StandardCharsets.UTF_8));
    }

    /**
     * V8：补齐历史上「改过 init.sql 却没配迁移」而漏掉的全部列。
     *
     * <p>这 16 列共同的历史欠账：它们是在各自表**建表之后**才加进 {@code init.sql} 的，
     * 而 {@code CREATE TABLE IF NOT EXISTS} 对已有库是空操作 ⇒ 只建过这些表的老库永远缺列，
     * 首次读该表就在运行期报 {@code Column "X" not found}。逐列 {@code hasColumn} 判定，
     * 新库天然空操作。</p>
     *
     * <p>V7 修的是同一类缺陷的一个实例，V8 是把审计出来的剩余实例一次结清；
     * 「以后再加列必须同时加迁移」由 {@code InitSqlMigrationCoverageTest} 守住。</p>
     */
    private void migrateV8(Connection connection) throws Exception {
        String[][] columns = {
                {"mcp", "command"}, {"session", "agent_id"},
                {"session", "context_token_count"}, {"session", "context_max_tokens"},
                {"session", "context_ratio"}, {"session_message", "turn_id"},
                {"mcp", "headers"}, {"mcp", "env"},
                {"tool_call", "content"}, {"tool_call", "raw_input"},
                {"tool_call", "raw_output"}, {"tool_call", "meta_data"},
                {"user_configs", "render_theme"}, {"user_configs", "data_dir"},
                {"user_configs", "skill_dir"}, {"user_configs", "team_size"},
        };
        for (String[] column : columns) {
            if (!hasColumn(connection, column[0], column[1])) {
                ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                        "db/migration/V8_" + column[0] + "_" + column[1] + ".sql"), StandardCharsets.UTF_8));
            }
        }
        ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V8_record.sql"), StandardCharsets.UTF_8));
    }

    private boolean hasColumn(Connection connection, String table, String column) throws Exception {
        try (ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if (table.equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && column.equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 列的声明宽度；列不存在返回 0（调用方须先判存在，别把 0 当成「太窄」）。 */
    private int columnSize(Connection connection, String table, String column) throws Exception {
        try (ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if (table.equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && column.equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    return columns.getInt("COLUMN_SIZE");
                }
            }
        }
        return 0;
    }
    /** 索引存在性按名字判定；H2 与 MySQL 都把索引挂在表上，这里逐表扫描一次。 */
    private boolean hasIndexNamed(Connection connection, String table, String indexName) throws Exception {
        try (ResultSet tables = connection.getMetaData().getTables(null, null, "%", new String[] {"TABLE"})) {
            while (tables.next()) {
                if (!table.equalsIgnoreCase(tables.getString("TABLE_NAME"))) continue;
                try (ResultSet indexes = connection.getMetaData()
                        .getIndexInfo(null, null, tables.getString("TABLE_NAME"), false, false)) {
                    while (indexes.next()) {
                        String name = indexes.getString("INDEX_NAME");
                        if (name != null && name.equalsIgnoreCase(indexName)) return true;
                    }
                }
            }
        }
        return false;
    }

    private List<String> parseTableNames(String sql) {
        List<String> names = new ArrayList<>();
        Matcher matcher = CREATE_TABLE.matcher(sql);
        while (matcher.find()) {
            names.add(matcher.group(1));
        }
        return names;
    }

    private List<String> findMissingTables(Connection connection, List<String> expected) throws Exception {
        List<String> present = new ArrayList<>();
        try (ResultSet tables = connection.getMetaData()
                .getTables(null, null, "%", new String[] { "TABLE" })) {
            while (tables.next()) {
                present.add(tables.getString("TABLE_NAME"));
            }
        }
        List<String> missing = new ArrayList<>();
        for (String name : expected) {
            boolean found = present.stream().anyMatch(p -> p.equalsIgnoreCase(name));
            if (!found) {
                missing.add(name);
            }
        }
        return missing;
    }
}

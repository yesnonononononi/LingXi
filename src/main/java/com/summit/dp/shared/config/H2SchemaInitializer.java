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
            }
        };
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
                {"chat_turn", "version"}, {"execution", "version"}, {"session_message", "stream_key"}};
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
                        if (name != null && name.toLowerCase(Locale.ROOT).startsWith("uk_session_stream_key")) indexPresent = true;
                    }
                }
            }
        }
        if (!indexPresent) ScriptUtils.executeSqlScript(connection, new EncodedResource(new ClassPathResource(
                "db/migration/V2_stream_key_index.sql"), StandardCharsets.UTF_8));
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

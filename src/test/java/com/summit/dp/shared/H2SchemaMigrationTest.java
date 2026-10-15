package com.summit.dp.shared;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import lombok.Data;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class H2SchemaMigrationTest {
    @Test
    void tokenDetailColumnsAreAvailableAfterRepeatedBootstrap() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL")
                .addScript("stream-legacy-schema.sql").build();
        try {
            assertTrue(hasColumn(database, "chat_turn", "total_token_count"));
            assertFalse(hasColumn(database, "chat_turn", "cache_tokens"));
            assertFalse(hasColumn(database, "chat_turn", "reasoning_tokens"));
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.addMapper(ChatTurnMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            ChatTurnMapper turns = new SqlSessionTemplate(factory.getObject()).getMapper(ChatTurnMapper.class);
            assertNull(turns.selectById(7L).getCacheTokens());
            assertNull(turns.selectById(7L).getReasoningTokens());
            ChatTurnPO row = ChatTurnPO.builder().id(7L).cacheTokens(12L).reasoningTokens(0L).build();
            turns.updateById(row);
            assertEquals(12L, turns.selectById(7L).getCacheTokens());
            assertEquals(0L, turns.selectById(7L).getReasoningTokens());
        } finally {
            database.shutdown();
        }
    }

    @Test
    void partialLegacyDatabaseKeepsDataAndMigrationRunsTwice() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL")
                .addScript("tool-call-legacy-schema.sql").build();
        try {
            SqlSessionTemplate session = session(database);
            ToolCallMapper tools = session.getMapper(ToolCallMapper.class);
            tools.insert(ToolCallPO.builder().id("call_legacy").conversationId(1L).executionId(11L)
                    .toolName("create_plan").type("PROMISE").status("pending")
                    .title("旧数据必须保留").content("{\"kind\":\"PLAN\"}").build());
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals("旧数据必须保留", tools.selectById("call_legacy").getTitle());
            assertTrue(hasColumn(database, "session_message", "response_id"), "正对照：能定位新建消息表的列");
            assertFalse(hasColumn(database, "session_message", "response_order"), "不应重新创建已废弃的响应序号");
            assertEquals(1L, tools.selectById("call_legacy").getVersion());
            assertEquals(0L, session.getMapper(ExecutionMapper.class).selectCount(null));
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals(1L, tools.selectCount(null));
            assertEquals(1, session.getMapper(SchemaVersionMapper.class).selectById(1).getVersion());
        } finally { database.shutdown(); }
    }

    /**
     * 旧形状的恢复请求表必须被整体重建，而不是被 {@code CREATE TABLE IF NOT EXISTS} 空操作放过。
     *
     * <p><b>为什么必须重建而不是补列</b>：旧形状的 {@code attempts} / {@code next_attempt_at} 是
     * 已废弃的重试退避语义；更要紧的是旧状态行（{@code EXHAUSTED} / {@code NEEDS_MANUAL}）
     * 不在新收口逻辑的取值集合（READY / CLAIMED）里，留着就等于那些执行永远收不了口。
     * 恢复请求是纯瞬态标记，旧数据按约定可全量舍弃。</p>
     */
    @Test
    void legacyResumeRequestTableIsRebuiltAndLegacyRowsDiscarded() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL")
                .addScript("tool-call-legacy-schema.sql").build();
        try {
            // 金丝雀：证明 hasColumn 这个扫描器本身有效，否则下面的 false 可能是假绿。
            assertTrue(hasColumn(database, "execution_resume_task", "state"),
                    "前置条件：旧形状里 state 列存在（扫描器有效性对照）");
            assertEquals(1L, countRows(database, "execution_resume_task"),
                    "前置条件：旧形状里有一条遗留请求行");

            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            assertFalse(hasColumn(database, "execution_resume_task", "attempts"),
                    "旧形状的 attempts 列必须被重建掉，CREATE IF NOT EXISTS 做不到这一点");
            assertFalse(hasColumn(database, "execution_resume_task", "next_attempt_at"),
                    "旧形状的 next_attempt_at 列必须被重建掉");
            assertEquals(0L, countRows(database, "execution_resume_task"),
                    "旧请求数据按约定全量舍弃：遗留的 EXHAUSTED 行不得留下");

            // 幂等：第二次启动不得再触发重建，也不得因为 DROP 报错
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertFalse(hasColumn(database, "execution_resume_task", "attempts"));
            assertTrue(hasColumn(database, "execution_resume_task", "generation"),
                    "重建后新形状的列必须齐备");
        } finally {
            database.shutdown();
        }
    }

    /**
     * 旧库的 team.description 只有 500，必须被迁移加宽到 1000。
     *
     * <p><b>为什么必须有这条</b>：加宽列不是「缺列」，{@code init.sql} 里改列宽对已有库完全无效
     * （{@code CREATE TABLE IF NOT EXISTS} 不改已存在列）。少了这个迁移，就是「前端放行 1000 字、
     * 后端校验也放行 1000 字、最后在 DB 列宽上炸掉」—— 这正是本次要修的缺陷形态。</p>
     */
    @Test
    void legacyNarrowTeamDescriptionColumnIsWidened() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL")
                .addScript("team-legacy-schema.sql").build();
        try {
            // 金丝雀：先证明列宽扫描器本身有效，否则下面的 500 可能是「扫不到 → 恒返回 0」的假绿
            assertEquals(500, columnSize(database, "team", "description"),
                    "前置条件：旧库的团队描述列宽确实是 500（扫描器有效性对照）");
            assertFalse(hasColumn(database, "team", "avatar"),
                    "前置条件：旧库的 team 表没有头像列");

            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            assertEquals(1000, columnSize(database, "team", "description"),
                    "init.sql 改列宽对已有库无效，必须由迁移显式 ALTER 加宽");
            assertTrue(hasColumn(database, "team", "avatar"),
                    "V6 迁移必须给旧库的 team 表补上头像列");
            assertEquals(1L, countRows(database, "team"), "加宽列不得丢数据");

            // 幂等：第二次启动不得再 ALTER（对已是 1000 的列应当直接跳过）
            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals(1000, columnSize(database, "team", "description"));
            assertTrue(hasColumn(database, "team", "avatar"));
            assertEquals(1L, countRows(database, "team"));
        } finally {
            database.shutdown();
        }
    }

    /**
     * 旧库的 email_message 缺 {@code dedup_key} 列与 {@code uk_email_message_dedup} 唯一索引，V7 必须一起补上。
     *
     * <p><b>为什么列与索引必须一起断言</b>：唯一索引才是「子执行终结提醒只投一次」的裁决点
     * （{@code EmailServiceImpl#sendMailOnce} 插入后靠唯一键冲突判定「已投递过」并回查旧消息）。
     * 只补列的话界面不再报错，但重复提醒会静默进收件箱 —— 比报错更难发现，所以这里把
     * 「重复去重键真的被拒」与「普通邮件多行 NULL 不被挡」都断言掉。</p>
     *
     * <p>该缺陷的实际症状是「主对话正常、一发生协作委派就报 Column "DEDUP_KEY" not found」：
     * 委派的子执行终结时要投通知邮件，旧库的 email_message 建于该列之前。</p>
     */
    @Test
    void legacyEmailMessageTableGetsDedupKeyColumnAndUniqueIndex() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL")
                .addScript("email-legacy-schema.sql").build();
        try {
            // 金丝雀：先证明列扫描器本身有效，否则下面的 false 可能是「扫不到 → 恒 false」的假绿
            assertTrue(hasColumn(database, "email_message", "content"),
                    "前置条件：列扫描器能定位 email_message 的既有列（扫描器有效性对照）");
            assertFalse(hasColumn(database, "email_message", "dedup_key"),
                    "前置条件：旧形状里没有去重键列");

            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            assertTrue(hasColumn(database, "email_message", "dedup_key"),
                    "init.sql 加列对已有库无效，必须由 V7 迁移显式 ALTER");
            assertEquals(1L, countRows(database, "email_message"), "补列不得丢数据");
            assertEquals("旧消息：补列不得丢数据", messageContent(database, 9001L), "旧消息内容必须原样保留");

            insertMessage(database, 9101L, "notify:root-1:agent-7");
            assertThrows(SQLException.class,
                    () -> insertMessage(database, 9102L, "notify:root-1:agent-7"),
                    "去重键重复必须被唯一索引拒绝：它就是「通知只投一次」的裁决点");
            insertMessage(database, 9103L, null);
            insertMessage(database, 9104L, null);
            assertEquals(4L, countRows(database, "email_message"),
                    "普通邮件没有去重键，多行 NULL 不得互相挡（被拒的那条不应落库）");

            // 幂等：第二次启动不得重建索引（重名 CREATE UNIQUE INDEX 会直接失败）
            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals(4L, countRows(database, "email_message"));
        } finally {
            database.shutdown();
        }
    }

    /** 按去重键空/非空各插一条，用于验证唯一索引的取舍边界。 */
    private void insertMessage(EmbeddedDatabase database, long id, String dedupKey) throws SQLException {
        try (Connection connection = database.getConnection();
             PreparedStatement insert = connection.prepareStatement(
                     "INSERT INTO email_message (id, email_id, sender_id, dedup_key, content, status)"
                             + " VALUES (?, 8001, 10, ?, '通知内容', 'PENDING')")) {
            insert.setLong(1, id);
            insert.setString(2, dedupKey);
            insert.executeUpdate();
        }
    }

    private String messageContent(EmbeddedDatabase database, long id) throws Exception {
        try (Connection connection = database.getConnection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT content FROM email_message WHERE id = ?")) {
            query.setLong(1, id);
            try (ResultSet rows = query.executeQuery()) {
                return rows.next() ? rows.getString(1) : null;
            }
        }
    }

    /**
     * V8：把「各自表**建表之后**才补进 init.sql」的 16 列从库里删掉，重启必须全部补回，且不动其他数据。
     *
     * <p><b>为什么用「先让 init.sql 建全表，再 DROP 掉目标列」而不是手抄 5 张表的旧形状 fixture</b>：
     * 手抄上百列本身就是新的出错面（类型抄错、抄漏一列都会变成假绿）；这里的老库形状由数据库
     * 自己生成，必然真实。</p>
     *
     * <p>这 16 列的共同来历：都在表建好之后才加进 init.sql，而 {@code CREATE TABLE IF NOT EXISTS}
     * 对已有库是空操作 ⇒ 老库永久缺列，首次读写该表就在运行期报 {@code Column "X" not found}。</p>
     */
    @Test
    void columnsAddedAfterTheirTableWasCreatedAreBackfilled() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").build();
        try {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            executeUpdate(database, "INSERT INTO mcp (id, name) VALUES (1, '旧服务器')");
            executeUpdate(database, "INSERT INTO user_configs (id) VALUES (1)");

            // 金丝雀：先证明 DROP 真的把这 16 列删掉了，否则下面的断言可能是「本来就有」的假绿
            assertTrue(hasColumn(database, "user_configs", "data_dir"), "前置条件：init.sql 建的库带该列");
            for (String[] column : BACKFILLED_COLUMNS) {
                dropDependentIndexes(database, column[0], column[1]);
                executeUpdate(database, "ALTER TABLE " + column[0] + " DROP COLUMN " + column[1]);
            }
            for (String[] column : BACKFILLED_COLUMNS) {
                assertFalse(hasColumn(database, column[0], column[1]),
                        "前置条件：" + column[0] + "." + column[1] + " 已从库里删掉（DROP 有效性对照）");
            }

            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            for (String[] column : BACKFILLED_COLUMNS) {
                assertTrue(hasColumn(database, column[0], column[1]),
                        "V8 必须给缺列的老库补上 " + column[0] + "." + column[1]);
            }
            assertEquals("旧服务器", scalar(database, "SELECT name FROM mcp WHERE id = 1"), "补列不得丢数据");
            assertEquals("LIGHT", scalar(database, "SELECT render_theme FROM user_configs WHERE id = 1"),
                    "NOT NULL DEFAULT 的列回填时必须给存量行填默认值，而不是留下 NULL");

            // 幂等：第三次启动不得重复 ALTER
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            for (String[] column : BACKFILLED_COLUMNS) {
                assertTrue(hasColumn(database, column[0], column[1]));
            }
        } finally {
            database.shutdown();
        }
    }

    /** V8 覆盖的 16 列：表 → 列。与 {@code H2SchemaInitializer#migrateV8} 的清单同源（迁移动了这里也要动）。 */
    private static final String[][] BACKFILLED_COLUMNS = {
            {"mcp", "command"}, {"session", "agent_id"},
            {"session", "context_token_count"}, {"session", "context_max_tokens"},
            {"session", "context_ratio"}, {"session_message", "turn_id"},
            {"mcp", "headers"}, {"mcp", "env"},
            {"tool_call", "content"}, {"tool_call", "raw_input"},
            {"tool_call", "raw_output"}, {"tool_call", "meta_data"},
            {"user_configs", "render_theme"}, {"user_configs", "data_dir"},
            {"user_configs", "skill_dir"}, {"user_configs", "team_size"},
    };

    /**
     * 删列前先删掉引用它的索引。
     *
     * <p>H2 的 {@code DROP COLUMN} 拒绝删除被索引引用的列（实测 {@code session.agent_id} 上有
     * {@code IDX_ROOT_AGENT}）。本用例只验证「列能否被补回」，索引丢失不在断言范围内，
     * 但必须先删掉才能把列删掉 —— 顺带也让这个造旧库的手法对以后新增的索引自动成立。</p>
     */
    private void dropDependentIndexes(EmbeddedDatabase database, String table, String column) throws Exception {
        List<String> indexes = new ArrayList<>();
        try (Connection connection = database.getConnection();
             PreparedStatement query = connection.prepareStatement(
                     "SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.INDEX_COLUMNS"
                             + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = ? AND COLUMN_NAME = ?")) {
            query.setString(1, table.toUpperCase(Locale.ROOT));
            query.setString(2, column.toUpperCase(Locale.ROOT));
            try (ResultSet rows = query.executeQuery()) {
                while (rows.next()) {
                    indexes.add(rows.getString(1));
                }
            }
        }
        for (String index : indexes) {
            executeUpdate(database, "DROP INDEX IF EXISTS " + index);
        }
    }

    private void executeUpdate(EmbeddedDatabase database, String sql) throws Exception {
        try (Connection connection = database.getConnection();
             Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    /** 取单行单列；无行返回 null。 */
    private String scalar(EmbeddedDatabase database, String sql) throws Exception {
        try (Connection connection = database.getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        }
    }

    /** 列的声明宽度；与 {@code H2SchemaInitializer#columnSize} 同口径。 */
    private int columnSize(EmbeddedDatabase database, String table, String column) throws Exception {
        try (Connection connection = database.getConnection();
             ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if (table.equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && column.equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    return columns.getInt("COLUMN_SIZE");
                }
            }
        }
        return 0;
    }

    /** 列是否存在；与 {@code H2SchemaInitializer#hasColumn} 同口径（逐表扫元数据）。 */
    private boolean hasColumn(EmbeddedDatabase database, String table, String column) throws Exception {
        try (Connection connection = database.getConnection();
             ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if (table.equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && column.equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private long countRows(EmbeddedDatabase database, String table) throws Exception {
        try (Connection connection = database.getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT COUNT(*) FROM " + table)) {
            rows.next();
            return rows.getLong(1);
        }
    }

    private SqlSessionTemplate session(EmbeddedDatabase database) throws Exception {
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ToolCallMapper.class);
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(SchemaVersionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        return new SqlSessionTemplate(factory.getObject());
    }

    interface SchemaVersionMapper extends BaseMapper<SchemaVersionPO> { }

    @Data
    @TableName("lingxi_schema_version")
    static class SchemaVersionPO {
        @TableId
        private Integer version;
    }
}

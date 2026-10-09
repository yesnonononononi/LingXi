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
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import lombok.Data;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class H2SchemaMigrationTest {
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

            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            assertEquals(1000, columnSize(database, "team", "description"),
                    "init.sql 改列宽对已有库无效，必须由迁移显式 ALTER 加宽");
            assertEquals(1L, countRows(database, "team"), "加宽列不得丢数据");

            // 幂等：第二次启动不得再 ALTER（对已是 1000 的列应当直接跳过）
            new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals(1000, columnSize(database, "team", "description"));
            assertEquals(1L, countRows(database, "team"));
        } finally {
            database.shutdown();
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

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
            assertEquals(1L, tools.selectById("call_legacy").getVersion());
            assertEquals(0L, session.getMapper(ExecutionMapper.class).selectCount(null));
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals(1L, tools.selectCount(null));
            assertEquals(1, session.getMapper(SchemaVersionMapper.class).selectById(1).getVersion());
        } finally { database.shutdown(); }
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

package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.shared.config.H2SchemaInitializer;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/** 旧库升级与重复启动都必须保留历史和补充的幂等身份。 */
class ResumeSupplementMigrationTest {
    @Test
    void legacyDatabaseUpgradesWithoutLosingHistoryAndEnforcesRequestUniqueness() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("stream-legacy-schema.sql").build();
        try {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.addMapper(SessionMessageMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            SessionMessageMapper messages = new SqlSessionTemplate(factory.getObject()).getMapper(SessionMessageMapper.class);
            assertEquals("保留历史", messages.selectById(90L).getContent());
            assertNull(messages.selectById(90L).getResumeRequestId());
            messages.insert(SessionMessagePO.builder().id(91L).sessionId(1L).turnId(7L).type("USER")
                    .content("补充要求").resumeRequestId("migration-request-id").build());
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            assertEquals("migration-request-id", messages.selectById(91L).getResumeRequestId());
            assertThrows(DuplicateKeyException.class, () -> messages.insert(SessionMessagePO.builder().id(92L)
                    .sessionId(1L).turnId(7L).type("USER").content("重复补充")
                    .resumeRequestId("migration-request-id").build()));
            assertEquals(2, messages.selectCount(null));
        } finally { database.shutdown(); }
    }
}

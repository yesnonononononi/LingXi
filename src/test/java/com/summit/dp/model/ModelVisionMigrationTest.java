package com.summit.dp.model;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.shared.config.H2SchemaInitializer;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ModelVisionMigrationTest {
    @Test
    void oldModelsKeepIndependentCredentialsAndRepeatedBootstrapPreservesBothChoices() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("model-vision-legacy.sql").build();
        try {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(ModelConfigMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setConfiguration(configuration);
            factory.setDataSource(database);
            ModelConfigMapper mapper = new SqlSessionTemplate(factory.getObject()).getMapper(ModelConfigMapper.class);
            assertFalse(mapper.selectById(42L).isVision());
            assertFalse(mapper.selectById(42L).isUseProvider());
            mapper.update(null, new LambdaUpdateWrapper<ModelConfigPO>().eq(ModelConfigPO::getId, 42L).set(ModelConfigPO::isVision, true));
            mapper.update(null, new LambdaUpdateWrapper<ModelConfigPO>().eq(ModelConfigPO::getId, 42L).set(ModelConfigPO::isUseProvider, true));
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            ModelConfigPO row = mapper.selectById(42L);
            assertTrue(row.isVision());
            assertTrue(row.isUseProvider());
            assertEquals("existing-key", row.getApiKey());
            assertEquals("custom-name", row.getModelName());
        } finally {
            database.shutdown();
        }
    }
}

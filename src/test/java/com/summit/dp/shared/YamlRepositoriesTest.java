package com.summit.dp.shared;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.infrastructure.persistence.mapper.McpMapper;
import com.summit.dp.mcp.infrastructure.persistence.po.McpPO;
import com.summit.dp.mcp.infrastructure.repository.McpRepositoryImpl;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.Infrastructure.repo.ModelConfigRepositoryImpl;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.config.YamlConfig;
import com.summit.dp.shared.utils.YamlSerializer;
import com.summit.dp.user_configs.domain.model.UserConfig;
import com.summit.dp.user_configs.infrastructure.persistence.mapper.UserConfigMapper;
import com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO;
import com.summit.dp.user_configs.infrastructure.repository.UserConfigRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.*;

class YamlRepositoriesTest {
    @TempDir Path directory;
    private EmbeddedDatabase database;
    private McpMapper mcpMapper;
    private ModelConfigMapper modelMapper;
    private UserConfigMapper userMapper;
    private YamlSerializer serializer;
    private McpRepositoryImpl mcps;
    private ModelConfigRepositoryImpl models;
    private UserConfigRepositoryImpl users;
    private TransactionTemplate transaction;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("yaml-config-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(McpMapper.class);
        configuration.addMapper(ModelConfigMapper.class);
        configuration.addMapper(UserConfigMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setConfiguration(configuration);
        factory.setDataSource(database);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mcpMapper = session.getMapper(McpMapper.class);
        modelMapper = session.getMapper(ModelConfigMapper.class);
        userMapper = session.getMapper(UserConfigMapper.class);
        serializer = new YamlSerializer(new YamlConfig().yamlMapper());
        mcps = new McpRepositoryImpl(mcpMapper, new ObjectMapper(), serializer, path("mcp").toString());
        models = new ModelConfigRepositoryImpl(modelMapper, serializer, path("models").toString());
        users = new UserConfigRepositoryImpl(userMapper, serializer, path("users").toString());
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));
    }

    @AfterEach
    void cleanup() { database.shutdown(); }

    private Path path(String name) { return directory.resolve(name + ".yaml"); }

    @Test
    void migratePreservesIdsCredentialsAndTimestamps() {
        Instant now = Instant.parse("2026-10-03T01:02:03Z");
        modelMapper.insert(ModelConfigPO.builder().id(42L).modelName("模型甲").baseUrl("http://localhost")
                .apiKey("secret").createTime(now).build());
        mcpMapper.insert(McpPO.builder().id(8L).name("服务甲").transport("stdio").status(1)
                .command("[\"node\",\"server.js\"]").env("{\"TOKEN\":\"secret\"}").createTime(now).build());
        userMapper.insert(UserConfigPO.builder().id(1L).agentId(7L).modelId(42L).workspaceType("local")
                .reasoningEffort("high").renderTheme("DARK").createTime(now).build());
        assertEquals("secret", models.findById(42L).orElseThrow().getApiKey());
        assertEquals(List.of("node", "server.js"), mcps.findById(8L).orElseThrow().getCommand());
        assertEquals(Map.of("TOKEN", "secret"), mcps.findByName(" 服务甲 ").orElseThrow().getEnv());
        assertEquals(7L, users.findSingleton().orElseThrow().getAgentId());
        assertEquals(now, serializer.deserialize(path("mcp"), new TypeReference<List<McpPO>>() {}).getFirst().getCreateTime());
        modelMapper.deleteById(42L);
        assertTrue(models.findById(42L).isPresent());
        ModelConfigRepositoryImpl reopened = new ModelConfigRepositoryImpl(modelMapper, serializer, path("models").toString());
        assertEquals("模型甲", reopened.findById(42L).orElseThrow().getModelName());
    }

    @Test
    void crudPaginationAndClearingFieldsWork() {
        Long id = models.saveAndReturnId(new ModelConfig(null, "http://localhost", "secret", "甲", "provider"));
        models.save(new ModelConfig(null, "http://localhost", "other", "乙", null));
        assertEquals(2, models.page(1, 1).getTotal());
        assertEquals(1, models.queryByPage(0, 0).getRecords().size());
        assertTrue(models.page(Integer.MAX_VALUE, 10).getRecords().isEmpty());
        ModelConfig config = models.findById(id).orElseThrow();
        config.update("修改", "http://localhost/new", "");
        models.updateById(config);
        assertEquals("", models.findById(id).orElseThrow().getApiKey());
        models.delete(config);
        assertFalse(models.findById(id).isPresent());
        assertNotEquals(id, models.saveAndReturnId(new ModelConfig(null, "http://localhost", "", "丙", null)));
        assertThrows(IllegalStateException.class, () -> models.updateById(config));
    }

    @Test
    void mcpFiltersAndStructuredFieldsSurviveReload() {
        mcps.save(Mcp.builder().id(2L).name("停用").transport(Mcp.Transport.STDIO).status(0).build());
        mcps.save(Mcp.builder().id(1L).name("启用").transport(Mcp.Transport.STDIO).status(1)
                .command(List.of("node", "路径 有空格.js")).env(Map.of("LANG", "中文")).build());
        assertEquals(List.of(1L), mcps.findEnabled().stream().map(Mcp::getId).toList());
        assertTrue(mcps.findByName("不存在").isEmpty());
        assertEquals(2, mcps.findList(List.of(2L, 1L)).size());
        assertEquals("中文", mcps.findById(1L).orElseThrow().getEnv().get("LANG"));
    }

    @Test
    void userSettingsKeepAgentAndCanClearNullableFields() {
        UserConfig config = UserConfig.defaultConfig();
        config.changeAgent(19L);
        users.save(config);
        UserConfig loaded = users.findSingleton().orElseThrow();
        assertEquals(19L, loaded.getAgentId());
        loaded.changeAgent(null);
        users.updateById(loaded);
        assertNull(users.findSingleton().orElseThrow().getAgentId());
    }

    @Test
    void transactionRollbackAndCommitCoverAllThreeRepositories() throws Exception {
        users.save(UserConfig.defaultConfig());
        models.queryByPage(1, 10);
        mcps.queryByPage(1, 10);
        String previous = Files.readString(path("users"));
        transaction.executeWithoutResult(status -> {
            UserConfig config = users.findSingleton().orElseThrow();
            config.changeAgent(5L);
            users.updateById(config);
            models.save(new ModelConfig(null, "http://localhost", "", "rollback", null));
            mcps.save(Mcp.builder().id(5L).name("回滚").transport(Mcp.Transport.STDIO).status(1).build());
            assertEquals(5L, users.findSingleton().orElseThrow().getAgentId());
            status.setRollbackOnly();
        });
        assertEquals(previous, Files.readString(path("users")));
        assertNull(users.findSingleton().orElseThrow().getAgentId());
        assertEquals(0, models.page(1, 10).getTotal());
        assertTrue(mcps.findById(5L).isEmpty());
        transaction.executeWithoutResult(status -> {
            UserConfig config = users.findSingleton().orElseThrow();
            config.changeAgent(6L);
            users.updateById(config);
            assertNull(serializer.deserialize(path("users"), new TypeReference<List<UserConfigPO>>() {}).getFirst().getAgentId());
        });
        assertEquals(6L, users.findSingleton().orElseThrow().getAgentId());
    }

    @Test
    void concurrentSavesKeepEveryRecord() throws Exception {
        models.page(1, 10);
        try (ExecutorService executor = Executors.newFixedThreadPool(6)) {
            List<Callable<Long>> operations = new ArrayList<>();
            for (int i = 0; i < 30; i++) {
                int index = i;
                operations.add(() -> transaction.execute(status -> models.saveAndReturnId(
                        new ModelConfig(null, "http://localhost", "", "模型" + index, null))));
            }
            List<Future<Long>> futures = executor.invokeAll(operations);
            List<Long> ids = new ArrayList<>();
            for (Future<Long> future : futures) ids.add(future.get());
            assertEquals(30, ids.stream().distinct().count());
            assertEquals(30, models.page(1, 100).getTotal());
        }
    }

    @Test
    void invalidYamlIsNotOverwrittenOrReimported() throws Exception {
        Files.writeString(path("models"), "- [broken");
        assertThrows(IllegalStateException.class, () -> models.page(1, 10));
        assertEquals("- [broken", Files.readString(path("models")));
        Files.writeString(path("models"), "");
        assertThrows(IllegalStateException.class, () -> models.page(1, 10));
        Files.writeString(path("models"), "[]");
        assertEquals(0, models.page(1, 10).getTotal());
    }

    @Test
    void yamlMapperDoesNotReplaceApplicationJsonMapper() throws Exception {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext(
                JsonConfig.class, YamlConfig.class, YamlSerializer.class)) {
            String json = context.getBean(ObjectMapper.class).writeValueAsString(Map.of("id", 42L));
            assertEquals("{\"id\":\"42\"}", json);
            assertTrue(context.getBean(YamlSerializer.class).serialize(Map.of("id", 42L)).contains("id: 42"));
        }
    }

    @Test
    void firstMigrationIsDiscardedOnRollbackAndReadOnlyRejectsWrites() {
        transaction.executeWithoutResult(status -> {
            models.save(new ModelConfig(null, "http://localhost", "", "取消", null));
            status.setRollbackOnly();
        });
        assertFalse(Files.exists(path("models")));
        TransactionTemplate readOnly = new TransactionTemplate(new DataSourceTransactionManager(database));
        readOnly.setReadOnly(true);
        assertThrows(IllegalStateException.class, () -> readOnly.executeWithoutResult(status ->
                models.save(new ModelConfig(null, "http://localhost", "", "禁止", null))));
    }
}

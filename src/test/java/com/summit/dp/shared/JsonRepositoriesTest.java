package com.summit.dp.shared;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.personalization.domain.model.Personalization;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.personalization.infrastructure.repository.PersonalizationRepositoryImpl;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.infrastructure.persistence.mapper.McpMapper;
import com.summit.dp.mcp.infrastructure.persistence.po.McpPO;
import com.summit.dp.mcp.infrastructure.repository.McpRepositoryImpl;
import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import com.summit.dp.model.Infrastructure.repo.ModelConfigRepositoryImpl;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.ddd.infrastructure.repository.json.JsonListCodec;
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
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.*;

class JsonRepositoriesTest {
    @TempDir Path directory;
    private EmbeddedDatabase database;
    private McpMapper mcpMapper;
    private ModelConfigMapper modelMapper;
    private UserConfigMapper userMapper;
    private McpRepositoryImpl mcps;
    private ModelConfigRepositoryImpl models;
    private UserConfigRepositoryImpl users;
    private TransactionTemplate transaction;
    private PersonalizationRepositoryImpl personalizations;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("json-config-schema.sql").build();
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
        personalizations = new PersonalizationRepositoryImpl( path("personalization").toString());
        mcps = new McpRepositoryImpl(mcpMapper, new ObjectMapper(), path("mcp").toString());
        models = new ModelConfigRepositoryImpl(modelMapper, path("models").toString());
        users = new UserConfigRepositoryImpl(userMapper, path("users").toString());
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));
    }

    @AfterEach
    void cleanup() { database.shutdown(); }

    private Path path(String name) { return directory.resolve(name + ".json"); }

    @Test
    void providerSourceSurvivesImportReopenRollbackAndExplicitDisable() {
        modelMapper.insert(ModelConfigPO.builder().id(44L).modelName("provider-model").baseUrl("http://localhost")
                .providerConfigId(7L).useProvider(true).build());
        ModelConfig imported = models.findById(44L).orElseThrow();
        assertTrue(imported.isUseProvider());
        assertNull(imported.getApiKey());
        ModelConfigRepositoryImpl reopened = new ModelConfigRepositoryImpl(modelMapper, path("models").toString());
        assertTrue(reopened.findById(44L).orElseThrow().isUseProvider());
        transaction.executeWithoutResult(status -> {
            ModelConfig pending = models.findById(44L).orElseThrow();
            pending.changeUseProvider(false);
            models.updateById(pending);
            status.setRollbackOnly();
        });
        assertTrue(reopened.findById(44L).orElseThrow().isUseProvider());
        imported.changeUseProvider(false);
        imported.changeApiKey("own-key");
        models.updateById(imported);
        assertFalse(reopened.findById(44L).orElseThrow().isUseProvider());
        assertEquals("own-key", reopened.findById(44L).orElseThrow().getApiKey());
    }

    @Test
    void legacyJsonWithoutSourceFlagKeepsItsOwnCredential() throws Exception {
        Files.writeString(path("models"), """
                [{"id":45,"modelName":"legacy","baseUrl":"http://localhost","apiKey":"old-key","providerConfigId":7}]
                """);
        ModelConfig legacy = models.findById(45L).orElseThrow();
        assertFalse(legacy.isUseProvider());
        assertEquals("old-key", legacy.getApiKey());
    }

    @Test
    void visionSurvivesImportReopenAndTransactionRollback() {
        modelMapper.insert(ModelConfigPO.builder().id(43L).modelName("custom-name").baseUrl("http://localhost")
                .apiKey("key").vision(true).build());
        ModelConfig imported = models.findById(43L).orElseThrow();
        assertTrue(imported.isVision());
        ModelConfigRepositoryImpl reopened = new ModelConfigRepositoryImpl(modelMapper, path("models").toString());
        assertTrue(reopened.findById(43L).orElseThrow().isVision());
        transaction.executeWithoutResult(status -> {
            ModelConfig pending = models.findById(43L).orElseThrow();
            pending.changeVision(false);
            models.updateById(pending);
            status.setRollbackOnly();
        });
        assertTrue(reopened.findById(43L).orElseThrow().isVision());
        imported.changeVision(false);
        models.updateById(imported);
        assertFalse(reopened.findById(43L).orElseThrow().isVision());
    }

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
        assertEquals(now, new JsonListCodec<>(McpPO.class).read(path("mcp")).getFirst().getCreateTime());
        modelMapper.deleteById(42L);
        assertTrue(models.findById(42L).isPresent());
        ModelConfigRepositoryImpl reopened = new ModelConfigRepositoryImpl(modelMapper, path("models").toString());
        assertEquals("模型甲", reopened.findById(42L).orElseThrow().getModelName());
    }

    @Test
    void crudPaginationAndClearingFieldsWork() {
        Long id = models.saveAndReturnId(new ModelConfig(null, "http://localhost", "secret", "甲", "provider", false));
        models.save(new ModelConfig(null, "http://localhost", "other", "乙", null, false));
        assertEquals(2, models.page(1, 1).getTotal());
        assertEquals(1, models.queryByPage(0, 0).getRecords().size());
        assertTrue(models.page(Integer.MAX_VALUE, 10).getRecords().isEmpty());
        ModelConfig config = models.findById(id).orElseThrow();
        config.changeModelName("修改");
        config.changeBaseUrl("http://localhost/new");
        config.changeApiKey("");
        models.updateById(config);
        assertEquals("", models.findById(id).orElseThrow().getApiKey());
        models.delete(config);
        assertFalse(models.findById(id).isPresent());
        assertNotEquals(id, models.saveAndReturnId(new ModelConfig(null, "http://localhost", "", "丙", null, false)));
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

    /**
     * 客户端容错参数必须原样穿过 JSON 仓储：配过的值要读得回来，null 要真的是 null。
     *
     * <p>这里刻意不用 {@code toDuration(..., DEFAULT)} 那类带缺省值的转换 —— 一旦回落成 20s/60s，
     * 「沿用客户端库默认」就被悄悄换成了某个业务值，老配置的连接行为随之改变。</p>
     */
    @Test
    void mcpClientTuningSurvivesReloadAndCanBeCleared() {
        Mcp tuned = Mcp.builder().id(11L).name("调过的").transport(Mcp.Transport.STREAMABLE_HTTP)
                .url("https://mcp.context7.com/mcp").status(1).build();
        tuned.changeProtocolVersion("2025-11-25");
        tuned.changeAutoHealthCheck(Boolean.FALSE);
        tuned.changeHealthCheckInterval(Duration.ofSeconds(30));
        tuned.changeReconnectInterval(Duration.ofSeconds(5));
        mcps.save(tuned);

        Mcp loaded = mcps.findById(11L).orElseThrow();
        assertEquals("2025-11-25", loaded.getProtocolVersion());
        assertEquals(Boolean.FALSE, loaded.getAutoHealthCheck());
        assertEquals(Duration.ofSeconds(30), loaded.getHealthCheckInterval());
        assertEquals(Duration.ofSeconds(5), loaded.getReconnectInterval());

        // 没配过的服务：四个字段必须都是 null，不得被缺省值填充
        mcps.save(Mcp.builder().id(12L).name("没配的").transport(Mcp.Transport.STREAMABLE_HTTP)
                .url("https://a.example/mcp").status(1).build());
        Mcp plain = mcps.findById(12L).orElseThrow();
        assertNull(plain.getProtocolVersion());
        assertNull(plain.getAutoHealthCheck());
        assertNull(plain.getHealthCheckInterval());
        assertNull(plain.getReconnectInterval());

        // 清空 → 必须真的回到 null，否则用户永远走不回客户端库默认
        loaded.changeProtocolVersion(null);
        loaded.changeAutoHealthCheck(null);
        loaded.changeHealthCheckInterval(null);
        loaded.changeReconnectInterval(null);
        mcps.updateById(loaded);

        Mcp cleared = mcps.findById(11L).orElseThrow();
        assertNull(cleared.getProtocolVersion());
        assertNull(cleared.getAutoHealthCheck());
        assertNull(cleared.getHealthCheckInterval());
        assertNull(cleared.getReconnectInterval());
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
            models.save(new ModelConfig(null, "http://localhost", "", "rollback", null, false));
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
            assertNull(new JsonListCodec<>(UserConfigPO.class).read(path("users")).getFirst().getAgentId());
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
                        new ModelConfig(null, "http://localhost", "", "模型" + index, null, false))));
            }
            List<Future<Long>> futures = executor.invokeAll(operations);
            List<Long> ids = new ArrayList<>();
            for (Future<Long> future : futures) ids.add(future.get());
            assertEquals(30, ids.stream().distinct().count());
            assertEquals(30, models.page(1, 100).getTotal());
        }
    }

    @Test
    void invalidJsonIsNotOverwrittenOrReimported() throws Exception {
        Files.writeString(path("models"), "- [broken");
        assertThrows(IllegalStateException.class, () -> models.page(1, 10));
        assertEquals("- [broken", Files.readString(path("models")));
        Files.writeString(path("models"), "");
        assertThrows(IllegalStateException.class, () -> models.page(1, 10));
        Files.writeString(path("models"), "[]");
        assertEquals(0, models.page(1, 10).getTotal());
    }

    @Test
    void configSerializerDoesNotReplaceApplicationJsonMapper() throws Exception {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext(
                JsonConfig.class)) {
            String json = context.getBean(ObjectMapper.class).writeValueAsString(Map.of("id", 42L));
            assertEquals("{\"id\":\"42\"}", json);
            models.save(new ModelConfig(42L, "http://localhost", "", "模型", null, false));
            assertTrue(new ObjectMapper().readTree(Files.readString(path("models"))).get(0).get("id").isIntegralNumber());
        }
    }

    @Test
    void allFourFilesAreStrictJsonArraysAndIgnoreOldYaml() throws Exception {
        Files.writeString(directory.resolve("models.yaml"), "- id: 99\n  modelName: 旧模型\n");
        models.save(new ModelConfig(42L, "http://localhost", "secret", "新模型", null, false));
        mcps.save(Mcp.builder().id(8L).name("服务").transport(Mcp.Transport.STDIO).status(1).build());
        users.save(UserConfig.defaultConfig());
        personalizations.save(Personalization.builder().id(3L).replyStyle(ReplyStyle.FRIENDLY)
                .title("用户").commonAgentName("灵犀").customInstruction("多行\n中文与\"引号\"").build());
        ObjectMapper strictJson = new ObjectMapper();
        for (String name : List.of("models", "mcp", "users", "personalization")) {
            assertTrue(strictJson.readTree(Files.readString(path(name))).isArray(), name);
        }
        assertFalse(models.findById(99L).isPresent());
        assertEquals("- id: 99\n  modelName: 旧模型\n", Files.readString(directory.resolve("models.yaml")));
    }

    @Test
    void personalizationCrudReloadRollbackAndConcurrentWrites() throws Exception {
        Instant created = Instant.parse("2026-10-03T01:02:03Z");
        Personalization original = Personalization.builder().id(3L).replyStyle(ReplyStyle.FRIENDLY)
                .title("用户").commonAgentName("灵犀").customInstruction("指令").createAt(created).build();
        personalizations.save(original);
        PersonalizationRepositoryImpl reopened = new PersonalizationRepositoryImpl( path("personalization").toString());
        Personalization loaded = reopened.findById(3L).orElseThrow();
        assertEquals(ReplyStyle.FRIENDLY, loaded.getReplyStyle());
        assertEquals(created, loaded.getCreateAt());
        loaded.changeTitle("新称呼");
        reopened.updateById(loaded);
        assertEquals("新称呼", personalizations.findById(3L).orElseThrow().getTitle());
        assertEquals(created, personalizations.findById(3L).orElseThrow().getCreateAt());
        String before = Files.readString(path("personalization"));
        transaction.executeWithoutResult(status -> {
            Personalization model = personalizations.findById(3L).orElseThrow();
            model.changeTitle("回滚称呼");
            personalizations.updateById(model);
            status.setRollbackOnly();
        });
        assertEquals(before, Files.readString(path("personalization")));
        try (ExecutorService executor = Executors.newFixedThreadPool(4)) {
            List<Callable<Void>> operations = new ArrayList<>();
            for (long id = 10; id < 20; id++) {
                long recordId = id;
                operations.add(() -> {
                    personalizations.save(Personalization.builder().id(recordId).build());
                    return null;
                });
            }
            for (Future<Void> future : executor.invokeAll(operations)) future.get();
        }
        assertEquals(11, reopened.queryByPage(1, 100).getTotal());
        personalizations.delete(loaded);
        assertTrue(reopened.findById(3L).isEmpty());
    }

    @Test
    void rejectsYamlSyntaxAndTrailingJsonWithoutReplacingFile() throws Exception {
        for (String invalid : List.of("- id: 42\n  modelName: YAML", "[] {}", "null")) {
            Files.writeString(path("models"), invalid);
            assertThrows(IllegalStateException.class, () -> models.page(1, 10));
            assertEquals(invalid, Files.readString(path("models")));
        }
    }

    @Test
    void firstMigrationIsDiscardedOnRollbackAndReadOnlyRejectsWrites() {
        transaction.executeWithoutResult(status -> {
            models.save(new ModelConfig(null, "http://localhost", "", "取消", null, false));
            status.setRollbackOnly();
        });
        assertFalse(Files.exists(path("models")));
        TransactionTemplate readOnly = new TransactionTemplate(new DataSourceTransactionManager(database));
        readOnly.setReadOnly(true);
        assertThrows(IllegalStateException.class, () -> readOnly.executeWithoutResult(status ->
                models.save(new ModelConfig(null, "http://localhost", "", "禁止", null, false))));
    }
}

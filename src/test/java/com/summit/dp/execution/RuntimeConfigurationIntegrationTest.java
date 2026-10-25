package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.McpTransport;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SensitiveDataSpec;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import com.summit.dp.execution.infrastructure.persistence.mapper.RuntimeConfigRevisionMapper;
import com.summit.dp.execution.infrastructure.repository.RuntimeConfigRevisionRepositoryImpl;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.DelegationRecorder;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.shared.config.H2SchemaInitializer;
import org.springframework.boot.DefaultApplicationArguments;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.ExecutionSnapshotReader;
import com.summit.dp.workflow.infrastructure.harness.LegacyExecutionSnapshotAdapter;
import com.summit.dp.workflow.infrastructure.harness.RuntimeConfigurationProviders;
import com.summit.dp.workflow.infrastructure.harness.agent.IChatAgent;
import com.summit.dp.workflow.infrastructure.harness.agent.SubAgent;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.runtime.agent.ChatAgent;
import com.summit.runtime.workspace.DefaultWorkspaceResolver;
import com.summit.runtime.workspace.LocalWorkspaceProvider;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RuntimeConfigurationIntegrationTest {
    private final ObjectMapper json = new JsonConfig().objectMapper();
    private EmbeddedDatabase database;
    private RuntimeConfigRevisionMapper rows;
    private RuntimeConfigRevisionRepositoryImpl repository;
    private DataSourceTransactionManager transactionManager;
    private RuntimeConfigurationService configurations;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("db/migration/V14_runtime_config_revision.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(RuntimeConfigRevisionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        rows = new SqlSessionTemplate(factory.getObject()).getMapper(RuntimeConfigRevisionMapper.class);
        repository = new RuntimeConfigRevisionRepositoryImpl(rows);
        transactionManager = new DataSourceTransactionManager(database);
        configurations = new RuntimeConfigurationService(repository, json, transactionManager);
    }

    @AfterEach
    void shutdown() { database.shutdown(); }

    @Test
    void changedCredentialsAndSettingsCreateImmutableRevisionsThatSurviveServiceRestart() {
        ModelConfig original = model("original-model-secret");
        SensitiveDataSpec first = configurations.freezeModel(31L, original);
        assertEquals(first, configurations.freezeModel(31L, original.toBuilder().build()));
        ModelConfig changed = original.toBuilder().apiKey("updated-model-secret").maxTokens(2048).build();
        SensitiveDataSpec second = configurations.freezeModel(31L, changed);
        assertEquals(1, first.getVersion());
        assertEquals(2, second.getVersion());
        assertEquals(first.getId(), second.getId());
        RuntimeConfigurationService restarted = new RuntimeConfigurationService(repository, json, transactionManager);
        assertEquals(original, restarted.resolveModel(first.getId(), first.getVersion()));
        assertEquals(changed, restarted.resolveModel(second.getId(), second.getVersion()));
        assertEquals(2, rows.selectCount(null));
        assertTrue(assertThrows(ClientException.class, () -> restarted.resolveModel(31L, 99)).getMessage().contains("version=99"));
        assertThrows(ClientException.class, () -> restarted.resolveModel(32L, 1));
        assertThrows(ClientException.class, () -> repository.updateById(repository.findRevision("MODEL", 31L, 1).orElseThrow()));
    }

    @Test
    void mcpRevisionsFreezeTheWholeServerSetAndIgnoreMapInsertionOrder() {
        configurations.freezeModel(1L, model("independent-model-secret"));
        LinkedHashMap<String, String> headers = new LinkedHashMap<>();
        headers.put("Authorization", "original-mcp-secret");
        headers.put("X-Trace", "trace");
        SensitiveDataSpec first = configurations.freezeMcp(mcp(headers));
        LinkedHashMap<String, String> reversed = new LinkedHashMap<>();
        reversed.put("X-Trace", "trace");
        reversed.put("Authorization", "original-mcp-secret");
        assertEquals(first, configurations.freezeMcp(mcp(reversed)));
        SensitiveDataSpec second = configurations.freezeMcp(mcp(Map.of("Authorization", "new-mcp-secret")));
        assertEquals(2, second.getVersion());
        assertEquals(headers, ((McpConfig.StreamableHttp) configurations.resolveMcp(first.getId(), 1).getMcp().getFirst().conf()).headers());
        assertNull(configurations.freezeMcp(null));
        assertThrows(ClientException.class, () -> configurations.resolveMcp(first.getId(), 3));
        assertEquals("independent-model-secret", configurations.resolveModel(first.getId(), 1).getApiKey());
    }

    @Test
    void rootRequestAndBothAgentsUsePersistedReferencesAfterSnapshotRestore() throws Exception {
        ModelConfig model = model("model-secret-canary");
        McpConfig mcp = mcp(Map.of("Authorization", "mcp-secret-canary"));
        assertTrue(json.writeValueAsString(model).contains("model-secret-canary"));
        assertTrue(json.writeValueAsString(mcp).contains("mcp-secret-canary"));
        configurations.freezeModel(31L, model("previous-model-secret"));
        configurations.freezeMcp(mcp(Map.of("Authorization", "previous-mcp-secret")));
        McpService mcpService = mock(McpService.class);
        when(mcpService.currentConfig()).thenReturn(mcp);
        RequestPreparer preparer = new RequestPreparer(null, mock(SessionRepository.class), null, null, null, null,
                ToolListProcessorTestSupport.create(), null, null, null, null, null, mcpService,
                new SkillRootResolver(""), null, new BusinessSystemPromptBuilder(""), mock(PersonalizationRepository.class), configurations);
        RuntimeContext context = new RuntimeContext(ExecutionContext.root(201L, "101", null, 31L,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.PRE_EXEC_CONFIRM), null, null,
                SessionVO.builder().id(201L).build(), List.of(), null, model, AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.PRE_EXEC_CONFIRM, false, null);
        AgentRequest request = preparer.buildRequest("prompt", context, List.of());
        assertNotNull(request.getModelConfigSpec());
        assertEquals(31L, request.getModelConfigSpec().getId().longValue());
        assertEquals(2, request.getModelConfigSpec().getVersion());
        assertNotNull(request.getMcpConfigSpec());
        assertEquals(2, request.getMcpConfigSpec().getVersion());
        Execution original = Execution.builder().id("101").executionState(ExecutionState.SUSPENDED).agentRequest(request).build();
        String snapshot = json.writeValueAsString(original);
        assertFalse(snapshot.contains("model-secret-canary"));
        assertFalse(snapshot.contains("mcp-secret-canary"));
        configurations.freezeModel(31L, model.toBuilder().apiKey("changed").build());
        configurations.freezeMcp(mcp(Map.of("Authorization", "changed")));
        AtomicInteger selected = new AtomicInteger();
        RequestModelInvokerFactory invokers = new RequestModelInvokerFactory() {
            public Selection select(String provider) { throw new AssertionError("必须传入解析后的配置"); }
            public Selection select(ModelConfig config) {
                assertEquals(model.toBuilder().maxRetries(0).build(), config);
                selected.incrementAndGet();
                return new Selection("test", command -> null, false);
            }
        };
        RuntimeFactory runtimes = (invoker, workspace, scope) -> execution -> execution;
        ScopeMcpProvider scopes = config -> { assertEquals(mcp, config); return McpToolScope.EMPTY; };
        DefaultWorkspaceResolver workspaces = new DefaultWorkspaceResolver(List.of(new LocalWorkspaceProvider()));
        try (AnnotationConfigApplicationContext application = new AnnotationConfigApplicationContext()) {
            application.registerBean(RuntimeConfigurationService.class, () -> configurations);
            application.registerBean(RuntimeFactory.class, () -> runtimes);
            application.registerBean(RequestModelInvokerFactory.class, () -> invokers);
            application.registerBean(WorkspaceResolver.class, () -> workspaces);
            application.registerBean("chatModelConfig", ModelConfig.class, () -> model("fallback"));
            application.registerBean(ScopeMcpProvider.class, () -> scopes);
            application.registerBean(ExecutionRepository.class, () -> mock(ExecutionRepository.class));
            application.registerBean(ExecutionControl.class, () -> mock(ExecutionControl.class));
            application.register(IChatAgent.class, SubAgent.class, RuntimeConfigurationProviders.class);
            application.refresh();
            for (ChatAgent agent : List.of(application.getBean(IChatAgent.class), application.getBean(SubAgent.class))) {
                Execution restored = new ExecutionSnapshotReader(json, new LegacyExecutionSnapshotAdapter(json, configurations)).read(snapshot);
                agent.execute(restored);
                assertFalse(json.writeValueAsString(restored).contains("model-secret-canary"));
                assertFalse(json.writeValueAsString(restored).contains("mcp-secret-canary"));
            }
        }
        assertEquals(2, selected.get());
    }

    @Test
    void legacySnapshotsArchiveTheirOriginalCredentialsBeforeRestoring() throws Exception {
        configurations.freezeModel(31L, model("current-secret"));
        ObjectNode tree = json.createObjectNode();
        tree.put("id", "101");
        ObjectNode request = tree.putObject("agentRequest");
        request.set("modelConfig", json.valueToTree(model("legacy-secret-canary")));
        request.set("mcpConfig", json.valueToTree(mcp(Map.of("Authorization", "legacy-mcp-canary"))));
        request.putObject("runtimeParameters").putObject("attributes").put(ExecutionAttributes.MODEL_CONFIG_ID, "31");
        tree.set("mcpConfig", request.get("mcpConfig"));
        Execution restored = new ExecutionSnapshotReader(json, new LegacyExecutionSnapshotAdapter(json, configurations)).read(json.writeValueAsString(tree));
        SensitiveDataSpec modelSpec = restored.getAgentRequest().getModelConfigSpec();
        assertNotNull(modelSpec);
        assertEquals(2, modelSpec.getVersion());
        assertEquals("legacy-secret-canary", configurations.resolveModel(modelSpec.getId(), modelSpec.getVersion()).getApiKey());
        assertNotNull(restored.getAgentRequest().getMcpConfigSpec());
        String sanitized = json.writeValueAsString(restored);
        assertFalse(sanitized.contains("legacy-secret-canary"));
        assertFalse(sanitized.contains("legacy-mcp-canary"));
        assertFalse(json.readTree(sanitized).path("agentRequest").has("modelConfig"));
        assertFalse(json.readTree(sanitized).has("mcpConfig"));
    }

    @Test
    void concurrentFreezesDeduplicatePayloadsAndAllocateDistinctRevisions() throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService pool = Executors.newFixedThreadPool(6)) {
            List<Future<SensitiveDataSpec>> pending = new ArrayList<>();
            for (int index = 0; index < 12; index++) {
                int payload = index % 3;
                pending.add(pool.submit(() -> {
                    start.await();
                    return configurations.freezeModel(31L, model("concurrent-" + payload));
                }));
            }
            start.countDown();
            Set<Integer> versions = new HashSet<>();
            for (Future<SensitiveDataSpec> future : pending) versions.add(future.get(15, TimeUnit.SECONDS).getVersion());
            assertEquals(Set.of(1, 2, 3), versions);
            assertEquals(3, rows.selectCount(null));
        }
    }

    @Test
    void configurationVersionsCommitIndependentlyOfAdmissionRollback() {
        TransactionTemplate admission = new TransactionTemplate(transactionManager);
        SensitiveDataSpec spec = admission.execute(status -> {
            SensitiveDataSpec pinned = configurations.freezeModel(31L, model("committed-secret"));
            status.setRollbackOnly();
            return pinned;
        });
        assertNotNull(spec);
        assertEquals("committed-secret", configurations.resolveModel(spec.getId(), spec.getVersion()).getApiKey());
        assertThrows(ClientException.class, () -> configurations.freezeModel(null, model("bad")));
        assertThrows(ClientException.class, () -> configurations.resolveModel(31L, 0));
    }

    @Test
    void childTurnMetadataUsesThePinnedModelRatherThanTheCurrentConfiguration() {
        SensitiveDataSpec pinned = configurations.freezeModel(31L, model("original"));
        configurations.freezeModel(31L, model("changed").toBuilder().modelName("changed-model").build());
        ChatTurnService turns = mock(ChatTurnService.class);
        ConversationTranscriptService transcript = mock(ConversationTranscriptService.class);
        AgentRequest request = AgentRequest.builder().executionId("101").modelConfigSpec(pinned).build();
        new DelegationRecorder(turns, transcript, configurations).record(201L,
                ToolExecution.builder().eventMetaData(Map.of()).build(), request, 202L, "202", null, "任务");
        verify(turns).acceptTurn(202L, 201L, null, 101L, "model", "test");
    }

    @Test
    void repeatedLegacyBootstrapAddsTheVersionStoreWithoutLosingPinnedRevisions() throws Exception {
        EmbeddedDatabase legacy = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("stream-legacy-schema.sql").build();
        try {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(legacy).run(new DefaultApplicationArguments());
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(RuntimeConfigRevisionMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(legacy);
            factory.setConfiguration(configuration);
            RuntimeConfigRevisionMapper revisions = new SqlSessionTemplate(factory.getObject()).getMapper(RuntimeConfigRevisionMapper.class);
            RuntimeConfigurationService service = new RuntimeConfigurationService(new RuntimeConfigRevisionRepositoryImpl(revisions),
                    json, new DataSourceTransactionManager(legacy));
            SensitiveDataSpec pinned = service.freezeModel(31L, model("preserved"));
            initializer.h2SchemaBootstrap(legacy).run(new DefaultApplicationArguments());
            assertEquals("preserved", service.resolveModel(pinned.getId(), pinned.getVersion()).getApiKey());
            assertEquals(1, revisions.selectCount(null));
        } finally {
            legacy.shutdown();
        }
    }

    private static ModelConfig model(String apiKey) {
        return ModelConfig.builder().provider("test").apiKey(apiKey).baseUrl("https://example.invalid")
                .modelName("model").timeout(Duration.ofMillis(1250)).maxTokens(1024).build();
    }

    private static McpConfig mcp(Map<String, String> headers) {
        McpConfig config = new McpConfig();
        config.setMcp(List.of(new McpConfig.MCP("server", null, McpTransport.STREAMABLE_HTTP,
                new McpConfig.StreamableHttp("https://example.invalid/mcp", headers, Duration.ofSeconds(3), Duration.ofSeconds(4)), 100)));
        return config;
    }
}

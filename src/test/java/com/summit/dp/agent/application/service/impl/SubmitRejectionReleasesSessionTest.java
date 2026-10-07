package com.summit.dp.agent.application.service.impl;

import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 提交被线程池拒绝后的收口与解锁。
 *
 * <p><b>为什么必须用真实组件</b>：这条路径上「释放没做」的后果是<b>会话被单飞锁死</b> ——
 * 用户再也发不出下一条，而这类回归用 mock 断言不出来（mock 的 {@code finishRoot} 照样「被调用」）。
 * 这里用真 H2 执行表 + 真 {@code DefaultExecutionController} + 真 {@code ChatTurnServiceImpl}
 * + 真 {@link SessionExecutionRegistry}：锁没释放时，下一次 {@code beginRoot} 会真的抛。</p>
 *
 * <p>本类必须留在 {@code com.summit.dp.agent.application.service.impl} 包内：
 * {@code failSubmit} 是<b>包可见</b>的，这是刻意的可测性设计（线程池拒绝难以在单测里稳定复现），
 * 不要为了「放得整齐」去动它的可见性。</p>
 */
class SubmitRejectionReleasesSessionTest {

    private static final long ROOT_SESSION_ID = 500L;
    private static final long TURN_ID = 9001L;

    private EmbeddedDatabase database;
    private TransactionTemplate transaction;
    private ExecutionMapper executionMapper;
    private ChatTurnMapper chatTurnMapper;
    private SessionExecutionRegistry registry;
    private PreparedChatExecutor executor;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql")
                .addScript("chat-turn-schema.sql")
                .build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ChatTurnMapper.class);
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(configuration, "test");
        TableInfoHelper.initTableInfo(assistant, ExecutionPO.class);
        TableInfoHelper.initTableInfo(assistant, ChatTurnPO.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        executionMapper = new SqlSessionTemplate(sessionFactory).getMapper(ExecutionMapper.class);
        chatTurnMapper = new SqlSessionTemplate(sessionFactory).getMapper(ChatTurnMapper.class);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));

        ChatTurnService chatTurnService = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
        LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(executionMapper,
                new JsonConfig().objectMapper(), chatTurnService);
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
        ExecutionControl control = new DefaultExecutionController(() -> null, repository, events,
                new DefaultRuntimeLifeStyleManager(events));

        registry = new SessionExecutionRegistry();
        AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
        RequestPreparer requestPreparer = mock(RequestPreparer.class);
        executor = new PreparedChatExecutor(orchestrator, requestPreparer,
                mock(ModelContextService.class), registry, control);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private static Execution execution(String executionId) {
        AgentRequest request = AgentRequest.builder()
                .executionId(executionId)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .eventMetaData(ExecutionEventMetadata.of(ROOT_SESSION_ID, ROOT_SESSION_ID, TURN_ID, null, 3L))
                        .build())
                .build();
        return Execution.builder().id(executionId).agentRequest(request)
                .executionState(ExecutionState.CREATED).messages(List.of()).build();
    }

    private static RuntimeContext context(String executionId) {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, executionId, null, 7L,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).historyRevision(3L).build(),
                List.of(), null, null, AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.FULL_ACCESS, false, UserMessageEntity.from("你好")).withTurnId(TURN_ID);
    }

    private void persistAccepted(Execution execution, long turnId) {
        transaction.executeWithoutResult(status -> {
            ChatTurnPO turn = new ChatTurnPO();
            turn.setId(turnId);
            turn.setVersion(1L);
            turn.setSessionId(ROOT_SESSION_ID);
            turn.setExecutionId(Long.valueOf(execution.getId()));
            turn.setStatus("ACCEPTED");
            turn.setCreatedAt(java.time.Instant.now());
            turn.setUpdatedAt(java.time.Instant.now());
            chatTurnMapper.insert(turn);
            ExecutionRepositoryTestFactory.create(executionMapper, new JsonConfig().objectMapper())
                    .save(execution);
        });
    }

    @Test
    @DisplayName("提交被拒：轮次收成终态、运行资格释放，同一会话紧接着还能再受理一次")
    void rejectedSubmitStillAllowsNextAcceptance() {
        String firstId = "2105000000000000001";
        Execution first = execution(firstId);
        persistAccepted(first, TURN_ID);

        // 走真实的「单飞 → 受理 → 提交被拒」序列：请求线程 beginRoot，异步提交被拒。
        registry.beginRoot(ROOT_SESSION_ID);
        assertDoesNotThrow(() -> executor.failSubmit(context(firstId).withExecution(first),
                        new RejectedExecutionException("线程池已满")),
                "收口本身不该抛：抛了会盖掉「线程池已满」这个真实原因（外抛由 submitAsync 负责）");

        ChatTurnPO turn = chatTurnMapper.selectById(TURN_ID);
        assertEquals("FAILED", turn.getStatus(), "被拒的轮次必须有终态，否则前端永远转圈");
        assertEquals(4, executionMapper.selectById(Long.valueOf(firstId)).getStatus());

        // 关键：单飞资格必须已释放 —— 真 registry 下再 beginRoot 若被锁死会抛。
        assertDoesNotThrow(() -> registry.beginRoot(ROOT_SESSION_ID),
                "提交失败后会话被单飞锁死，用户再也发不出下一条");
        registry.finishRoot(ROOT_SESSION_ID);
    }
}
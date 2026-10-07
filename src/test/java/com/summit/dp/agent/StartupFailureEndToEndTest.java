package com.summit.dp.agent;

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
import com.summit.dp.agent.application.service.impl.PreparedChatExecutor;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.infrastructure.listener.ChatTurnRuntimeListener;
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
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 启动失败的端到端链路：服务端收口之后，客户端<b>真的</b>收到 EXECUTION_FAILED。
 *
 * <p><b>为什么必须有这个测试</b>：其余用例全都把 {@code SseEventPublisher} 或 emitter mock 掉，
 * 断言退化成「某个 mock 被调用过」——把广播那一环整个删掉也照样绿，前端却会永远停在「生成中」。
 * 只有这里用<b>真实 emitter</b> 接一条真实 SSE 链，逐环都是生产实现：
 * {@code LocalExecutionRepository} / {@code DefaultExecutionController} /
 * {@code DefaultRuntimeLifeStyleManager} / {@code RuntimeEventPublisher} / {@code AgentEventListener} /
 * {@code ChatTurnRuntimeListener} /
 * {@code ChatTurnServiceImpl}（H2 真表）。只 mock 模型调用与请求准备。</p>
 */
class StartupFailureEndToEndTest {

    private static final long ROOT_SESSION_ID = 500L;
    private static final String EXECUTION_ID = "2105000000000000001";
    private static final long TURN_ID = 9001L;

    /** 记录真实 emitter 上收到的事件名（而不是 mock 掉 emitter 只数调用次数）。 */
    private static final class RecordingEmitter extends SseEmitter {
        private final List<String> frames = new ArrayList<>();

        RecordingEmitter() {
            super(0L);
        }

        @Override
        public void send(SseEventBuilder builder) throws java.io.IOException {
            StringBuilder text = new StringBuilder();
            for (SseEmitter.DataWithMediaType item : builder.build()) {
                text.append(item.getData());
            }
            frames.add(text.toString());
            super.send(builder);
        }
    }

    private EmbeddedDatabase database;
    private TransactionTemplate transaction;
    private ExecutionMapper executionMapper;
    private ChatTurnMapper chatTurnMapper;
    private RecordingEmitter emitter;
    private SseEventPublisher publisher;
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
        executionMapper = new org.mybatis.spring.SqlSessionTemplate(sessionFactory).getMapper(ExecutionMapper.class);
        chatTurnMapper = new org.mybatis.spring.SqlSessionTemplate(sessionFactory).getMapper(ChatTurnMapper.class);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));

        SessionRepository sessionRepository = mock(SessionRepository.class);
        when(sessionRepository.findById(ROOT_SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(ROOT_SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).build()));
        ExecutionIdentity identity = new ExecutionIdentity(executionMapper, sessionRepository);

        ChatTurnService chatTurnService = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));

        publisher = new SseEventPublisher() {
            @Override
            protected SseEmitter newEmitter() {
                return emitter;
            }
        };
        emitter = new RecordingEmitter();
        // 先连上流：客户端「连接与心跳都正常」，随后服务端收口失败。
        publisher.connect(ROOT_SESSION_ID);

        AgentEventListener agentEvents = new AgentEventListener(new JsonConfig().objectMapper(),
                publisher, identity);
        agentEvents.init();
        RuntimeEventPublisher events = new RuntimeEventPublisher(List.of(
                new ChatTurnRuntimeListener(chatTurnService),
                agentEvents,
                new NoopRuntimeListener()));
        LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(executionMapper,
                new JsonConfig().objectMapper(), chatTurnService);

        AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("模型不可用"));
        ExecutionControl control = new DefaultExecutionController(() -> null, repository, events,
                new DefaultRuntimeLifeStyleManager(events));
        executor = new PreparedChatExecutor(orchestrator, mock(RequestPreparer.class),
                mock(ModelContextService.class), new SessionExecutionRegistry(), control);
    }

    @AfterEach
    void shutdown() {
        publisher.close();
        database.shutdown();
    }

    /** 占位监听器：证明 RuntimeEventPublisher 按列表顺序回调，业务监听器都在链上。 */
    private static final class NoopRuntimeListener
            implements com.summit.core.runtime.RuntimeListener {
    }

    private static Execution execution() {
        AgentRequest request = AgentRequest.builder()
                .executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .eventMetaData(ExecutionEventMetadata.of(ROOT_SESSION_ID, ROOT_SESSION_ID, TURN_ID, null, 3L))
                        .build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentRequest(request)
                .executionState(ExecutionState.CREATED).messages(List.of()).build();
    }

    private static RuntimeContext context(Execution execution) {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, EXECUTION_ID, null, 7L,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        RuntimeContext context = new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).historyRevision(3L).build(),
                List.of(), null, null, AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.FULL_ACCESS, false, UserMessageEntity.from("你好")).withTurnId(TURN_ID);
        return context.withExecution(execution);
    }

    /** 先造出「已受理」的现实：轮次行 + 执行行（CREATED）都在库里。 */
    private void persistAccepted(Execution execution) {
        transaction.executeWithoutResult(status -> {
            ChatTurnPO turn = new ChatTurnPO();
            turn.setId(TURN_ID);
            turn.setVersion(1L);
            turn.setSessionId(ROOT_SESSION_ID);
            turn.setExecutionId(Long.valueOf(EXECUTION_ID));
            turn.setStatus("ACCEPTED");
            turn.setCreatedAt(java.time.Instant.now());
            turn.setUpdatedAt(java.time.Instant.now());
            chatTurnMapper.insert(turn);
            ExecutionRepositoryTestFactory.create(executionMapper, new JsonConfig().objectMapper())
                    .save(execution);
        });
    }

    @Test
    @DisplayName("启动失败后真实 emitter 上确实收到 EXECUTION_FAILED，且轮次已收成 FAILED")
    void startupFailureReachesRealEmitter() {
        Execution execution = execution();
        persistAccepted(execution);

        assertThrows(IllegalStateException.class, () -> executor.run(context(execution)));

        String all = String.join("\n", emitter.frames);
        assertTrue(all.contains("EXECUTION_FAILED"),
                "真实 emitter 必须收到失败终态事件，否则前端永远停在生成中");

        ChatTurnPO turn = chatTurnMapper.selectById(TURN_ID);
        assertEquals("FAILED", turn.getStatus());
        assertEquals("模型不可用", turn.getErrorReason());

        ExecutionPO row = executionMapper.selectById(Long.valueOf(EXECUTION_ID));
        assertEquals(4, row.getStatus(), "执行行必须落 FAILED 终态");
    }
}
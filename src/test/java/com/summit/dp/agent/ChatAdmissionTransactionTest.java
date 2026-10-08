package com.summit.dp.agent;

import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.application.service.impl.PreparedChatExecutor;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.application.service.TranscriptReplayMatcher;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.skill.SkillRootResolver;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 受理事务的原子性：轮次、用户消息与执行行必须共同提交 / 共同回滚。
 *
 * <p><b>为什么不能用「调用顺序」测试代替</b>：{@code InOrder} 只证明调用发生的先后，
 * mock 之间没有事务，证明不了任何原子性。这里用真实 H2 + 真实 {@code TransactionTemplate}
 * + 三张真表（各自的真仓储），异常路径断言三表零行、正常路径断言三表各一行。</p>
 *
 * <p>⚠️ 测试里显式包 {@code TransactionTemplate} 是必需的：{@code @Transactional} 靠代理生效，
 * 手工 {@code new} 出来的实例没有代理；生产环境的代理由 Spring 提供。</p>
 */
class ChatAdmissionTransactionTest {

    private static final long SESSION_ID = 500L;
    private static final long MODEL_ID = 7L;
    private static final String EXECUTION_ID = "2105000000000000001";
    private static final long EXECUTION_ID_NUMERIC = 2105000000000000001L;

    private EmbeddedDatabase database;
    private TransactionTemplate transaction;
    private ExecutionMapper executionMapper;
    private ChatTurnMapper chatTurnMapper;
    private SessionMessageMapper sessionMessageMapper;
    private LocalExecutionRepository executionRepository;
    private PreparedChatExecutor executor;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql")
                .addScript("chat-turn-schema.sql")
                .addScript("session-message-schema.sql")
                .build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        // 不要关驼峰转下划线：SessionMessagePO 没有 @TableField，靠这个开关映射 session_id。
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ChatTurnMapper.class);
        configuration.addMapper(SessionMessageMapper.class);
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(configuration, "test");
        TableInfoHelper.initTableInfo(assistant, ExecutionPO.class);
        TableInfoHelper.initTableInfo(assistant, ChatTurnPO.class);
        TableInfoHelper.initTableInfo(assistant, SessionMessagePO.class);

        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = new SqlSessionTemplate(sessionFactory);
        executionMapper = template.getMapper(ExecutionMapper.class);
        chatTurnMapper = template.getMapper(ChatTurnMapper.class);
        sessionMessageMapper = template.getMapper(SessionMessageMapper.class);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));

        executionRepository = ExecutionRepositoryTestFactory.create(executionMapper,
                new JsonConfig().objectMapper());
        ChatTurnServiceImpl chatTurnService = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
        ConversationTranscriptService transcriptService = new ConversationTranscriptService(
                new SessionMessageRepositoryImpl(sessionMessageMapper, mock(SessionMapper.class)),
                mock(ToolCallRepository.class),
                new TranscriptRecordAssembler(new JsonConfig().objectMapper()),
                new TranscriptReplayMatcher(new JsonConfig().objectMapper()));
        // 真实受理器：只替换与本次无关的协作者，落库两条链都是真实现。
        RequestPreparer requestPreparer = new RequestPreparer(mock(SessionService.class),
                mock(SessionRepository.class), mock(WorkspaceService.class), mock(ModelService.class),
                mock(WorkspaceConverter.class), mock(SettingsProvider.class), mock(ToolCatalog.class),
                transcriptService, mock(ModelContextService.class), mock(ExecutionIdentity.class),
                chatTurnService, mock(com.summit.dp.agent.application.service.AgentService.class),
                mock(TeamService.class), mock(McpService.class), new SkillRootResolver(""));
        executor = new PreparedChatExecutor(orchestrator, requestPreparer,
                mock(ModelContextService.class), mock(SessionExecutionRegistry.class),
                mock(ExecutionControl.class));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);

    private static Execution execution(ExecutionState state) {
        AgentRequest request = AgentRequest.builder()
                .executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID)))
                        .build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentRequest(request)
                .executionState(state).messages(List.of()).build();
    }

    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(SESSION_ID, EXECUTION_ID,
                null, MODEL_ID, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(SESSION_ID).build(), List.of(UserMessageEntity.from("你好")),
                null, null, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false,
                UserMessageEntity.from("你好"));
    }

    @Test
    @DisplayName("创建执行失败：轮次、用户消息与执行行一起回滚，不留半条记录")
    void admissionRollsBackAllThreeTablesWhenExecutionCreationFails() {
        Execution created = execution(ExecutionState.CREATED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenAnswer(invocation -> {
            // 先真写执行行（真实仓储），再模拟编排失败（团队 / Agent 查询或请求构建失败）。
            executionRepository.save(created);
            throw new ClientException("未找到指定的团队");
        });

        assertThrows(ClientException.class,
                () -> transaction.executeWithoutResult(status -> executor.admit(context())));

        assertEquals(0, chatTurnMapper.selectList(null).size(), "轮次必须一起回滚");
        assertEquals(0, sessionMessageMapper.selectList(null).size(), "用户消息必须一起回滚");
        assertEquals(0, executionMapper.selectList(null).size(), "执行行必须一起回滚");
    }

    @Test
    @DisplayName("受理成功：三表共同可见，且执行行带完整快照（否则恢复路径读不到它）")
    void admissionCommitsTurnMessageAndExecutionWithSnapshot() {
        Execution created = execution(ExecutionState.CREATED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenAnswer(invocation -> {
            executionRepository.save(created);
            return created;
        });

        RuntimeContext admitted = transaction.execute(status -> executor.admit(context()));

        assertNotNull(admitted.turnId(), "受理必须产出轮次 ID");
        assertEquals(created, admitted.execution(), "受理必须把执行对象带回上下文");
        assertEquals(1, chatTurnMapper.selectList(null).size());
        assertEquals(1, sessionMessageMapper.selectList(null).size());
        assertEquals(1, executionMapper.selectList(null).size());

        ChatTurnPO turn = chatTurnMapper.selectList(null).getFirst();
        assertEquals(EXECUTION_ID_NUMERIC, turn.getExecutionId(), "轮次与执行共享同一个身份");

        SessionMessagePO message = sessionMessageMapper.selectList(null).getFirst();
        assertEquals(turn.getId(), message.getTurnId(), "用户消息归属 acceptTurn 返回的轮次");

        ExecutionPO row = executionMapper.selectById(EXECUTION_ID_NUMERIC);
        assertNotNull(row.getSnapshot(), "执行行必须写完整快照 —— 这是本次改造要修掉的核心事实");
        assertEquals(0, row.getStatus(), "受理阶段登记为 CREATED");
        assertEquals(SESSION_ID, row.getSessionId());
    }

    @Test
    @DisplayName("回执带的是落库那一行的 turnId，且两个雪花 ID 以字符串下发")
    void receiptCarriesPersistedTurnIdAndSerializesIdsAsStrings() throws Exception {
        Execution created = execution(ExecutionState.CREATED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenAnswer(invocation -> {
            executionRepository.save(created);
            return created;
        });

        RuntimeContext admitted = transaction.execute(status -> executor.admit(context()));

        // 必须是「等于」而不是「非空」：前端拿这个 id 去对齐事件与历史，对不上就等于没返回。
        ChatTurnPO turn = chatTurnMapper.selectList(null).getFirst();
        assertEquals(turn.getId(), admitted.turnId(), "回执的 turnId 必须就是落库那一行的 id");

        // 雪花 ID 超出 JS 安全整数范围，下成数字会被静默截断 —— 这是对外契约，不是序列化细节。
        ChatAcceptanceVO receipt = ChatAcceptanceVO.builder()
                .sessionId(SESSION_ID).turnId(admitted.turnId()).build();
        ObjectMapper mapper = new JsonConfig().objectMapper();
        String json = mapper.writeValueAsString(receipt);
        assertTrue(json.contains("\"sessionId\":\"" + SESSION_ID + "\""), "sessionId 必须字符串下发：" + json);
        assertTrue(json.contains("\"turnId\":\"" + admitted.turnId() + "\""), "turnId 必须字符串下发：" + json);
    }
}

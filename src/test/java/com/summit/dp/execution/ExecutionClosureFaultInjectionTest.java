package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.application.service.impl.ToolCallServiceImpl;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.ExecutionStartupReaper;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 收口事实的故障注入：提交后的收口失败必须留下可重试的库内事实，而不是只留一行日志。
 *
 * <p>三条用例对应三件必须成立的事：</p>
 * <ol>
 *   <li>必须成功的步骤失败时，前面的成功不冒充整体成功（不广播、不清待收口位）；</li>
 *   <li>一条<b>从来没有恢复请求、也没有任何标记</b>的终态执行，重启后仍能被补做收口
 *       —— 这是「待收口位放在同一条 UPDATE 里」的全部意义；</li>
 *   <li>补偿一次之后，重复启动不会重复交付、重复广播。</li>
 * </ol>
 *
 * <p>全部用真实 H2 + 真实仓储读写事实：这里的失败模式恰恰是「内存里以为做了、库里没有」，
 * mock 掉落库就什么也证明不了。</p>
 */
class ExecutionClosureFaultInjectionTest {

    private static final long EXECUTION_ID = 740_001L;
    private static final String EXECUTION_ID_TEXT = String.valueOf(EXECUTION_ID);
    private static final long TURN_ID = 740_002L;
    private static final String TOOL_CALL_ID = "call_closure_740";
    private static final long ROOT_SESSION_ID = 740_003L;
    private static final long CHILD_SESSION_ID = 740_004L;
    private static final long ROOT_EXECUTION_ID = 740_005L;

    private H2TestDatabase database;
    private ExecutionMapper executionMapper;
    private ToolCallMapper toolCallMapper;
    private ChatTurnMapper chatTurnMapper;
    private SessionMapper sessionMapper;
    private ExecutionResumeTaskMapper resumeTaskMapper;
    private ExecutionRepository executions;
    private ExecutionResumeTaskRepository resumeTasks;
    private ObjectMapper objectMapper;
    private LocalFileCheckpointStore checkpointStore;
    private ExecutionCheckpointService checkpointService;

    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);
    private final SubAgentCompleteNotifier notifier = mock(SubAgentCompleteNotifier.class);
    private SubExecutionLifecycle subExecution;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ExecutionClosureFaultInjectionTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ToolCallMapper.class);
        configuration.addMapper(ChatTurnMapper.class);
        configuration.addMapper(SessionMapper.class);
        configuration.addMapper(ExecutionResumeTaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();

        executionMapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(ExecutionMapper.class);
        toolCallMapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class);
        chatTurnMapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(ChatTurnMapper.class);
        sessionMapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionMapper.class);
        resumeTaskMapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(ExecutionResumeTaskMapper.class);

        executions = new ExecutionRepositoryImpl(executionMapper);
        resumeTasks = new ExecutionResumeTaskRepositoryImpl(resumeTaskMapper);
        subExecution = new SubExecutionLifecycle(registry, wakeups,
                new com.summit.dp.execution.application.service.ExecutionLocator(
                        executions, new SessionRepositoryImpl(sessionMapper)), notifier);
        objectMapper = new JsonConfig().objectMapper();
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        checkpointStore = new LocalFileCheckpointStore(dataDir.toString(), objectMapper, 0L);
        checkpointService = new ExecutionCheckpointService(executions, mock(ApplicationEventPublisher.class));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("收口业务轮次失败：卡片已收口、轮次未收口、不广播、待收口位仍为 1")
    void requiredStepFailurePublishesNothing() {
        fixture();
        ChatTurnService brokenTurns = mock(ChatTurnService.class);
        doThrow(new IllegalStateException("轮次收口失败")).when(brokenTurns)
                .markTerminal(anyString(), any(), any(), any(), any(), any(), any());
        LocalExecutionRepository runtime = runtime(
                projection(cardsService(), brokenTurns, subExecution, runtimeEvents));
        saveRunning(runtime);

        // 与生产同一条入口：没有控制槽位时取消收口由 requireCancel 负责。
        runtime.requireCancel(EXECUTION_ID_TEXT);

        assertEquals(com.summit.dp.toolcall.domain.model.ToolCallStatus.COMPLETED.dbValue(), cardStatus(),
                "必须成功的卡片收口发生在失败步骤之前，必须真的落库");
        assertEquals("RUNNING", turnStatus(), "轮次沒收口就是没收口：不得因为前面做成了就标成终态");
        verify(runtimeEvents, never()).onExecutionCancelled(any(ExecutionCancelledEvent.class));
        assertEquals(Integer.valueOf(1), pendingFlag(),
                "收口没做完，待收口位必须留在库里 —— 这是重启后重试的唯一依据");
    }

    @Test
    @DisplayName("没有任何恢复请求、没有任何标记的终态执行，重启后仍能被补做收口")
    void brandNewTerminalExecutionWithoutResumeTaskIsClosedOnStartup() {
        fixture();
        // 提交阶段：投影不执行（等价于「提交后立刻崩溃」），因此库内只剩待收口位这一条事实。
        LocalExecutionRepository savingRuntime = runtime(mock(ExecutionLifecycleProjection.class));
        saveTerminal(savingRuntime, ExecutionState.CANCELLED);

        assertEquals(Integer.valueOf(1), pendingFlag(), "前提：终态与待收口位必须同时落库");
        assertEquals("RUNNING", turnStatus(), "前提：崩溃前投影没跑，轮次还停在运行中");
        assertTrue(resumeTasks.listUnfinished(10).isEmpty(), "前提：这条执行从来没有恢复请求");

        // 重启：全新 reaper 实例，只靠库里的待收口位找活。
        ExecutionLifecycleProjection readingProjection =
                projection(cardsService(), chatTurnService(), subExecution, runtimeEvents);
        LocalExecutionRepository readingRuntime = runtime(readingProjection);
        reaper(readingRuntime, readingProjection)
                .onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals("CANCELLED", turnStatus(), "重启后轮次必须被收口");
        assertEquals(com.summit.dp.toolcall.domain.model.ToolCallStatus.COMPLETED.dbValue(), cardStatus(),
                "重启后卡片必须被收口");
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION_ID),
                "重启后子执行结束事实必须到位（登记表里不能再留着这个子执行）");
        assertEquals(Integer.valueOf(0), pendingFlag(), "收口完成后待收口位必须清零");
    }

    @Test
    @DisplayName("同一夹具连跑两次补偿：交付与广播各只发生一次")
    void retryDoesNotDuplicateDelivery() {
        fixture();
        LocalExecutionRepository savingRuntime = runtime(mock(ExecutionLifecycleProjection.class));
        saveTerminal(savingRuntime, ExecutionState.CANCELLED);

        ChatTurnService spiedTurns = spy(chatTurnService());
        ExecutionLifecycleProjection readingProjection =
                projection(cardsService(), spiedTurns, subExecution, runtimeEvents);
        LocalExecutionRepository readingRuntime = runtime(readingProjection);

        reaper(readingRuntime, readingProjection).onApplicationEvent(mock(ApplicationReadyEvent.class));
        reaper(readingRuntime, readingProjection).onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(spiedTurns, times(1)).markTerminal(anyString(), any(), any(), any(), any(), any(), any());
        verify(runtimeEvents, times(1)).onExecutionCancelled(any(ExecutionCancelledEvent.class));
        assertEquals("CANCELLED", turnStatus());
        assertEquals(com.summit.dp.toolcall.domain.model.ToolCallStatus.COMPLETED.dbValue(), cardStatus());
        assertEquals(Integer.valueOf(0), pendingFlag());
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    @Test
    @DisplayName("非终态写库不得置待收口位：置了会让巡检反复扫到一条永远收不了口的行")
    void nonTerminalSaveNeverMarksClosurePending() {
        fixture();
        LocalExecutionRepository savingRuntime = runtime(mock(ExecutionLifecycleProjection.class));

        savingRuntime.save(execution(ExecutionState.CREATED));
        assertEquals(Integer.valueOf(0), pendingFlag(),
                "CREATED 不是终态，待收口位必须是 0，否则巡检会把它当成待办");
        assertFalse(executions.findClosurePendingIds(100).contains(EXECUTION_ID),
                "CREATED 行不得出现在启动扫描结果里");
        assertFalse(executions.findClosurePendingIdsAfter(0L, 100).contains(EXECUTION_ID),
                "CREATED 行不得出现在游标扫描结果里");

        savingRuntime.save(execution(ExecutionState.RUNNING));
        assertEquals(Integer.valueOf(0), pendingFlag(), "RUNNING 不是终态，待收口位必须是 0");

        savingRuntime.save(execution(ExecutionState.SUSPENDED));
        assertEquals(Integer.valueOf(0), pendingFlag(),
                "SUSPENDED 只是等待人工决策，不是终态，待收口位必须是 0");
        assertFalse(executions.findClosurePendingIds(100).contains(EXECUTION_ID),
                "SUSPENDED 行不得出现在启动扫描结果里：completeClosure 对非终态直接 return 且不清位，"
                        + "扫到它只会让每一轮巡检把这条永远收不了口的行空转一遍");
        assertFalse(executions.findClosurePendingIdsAfter(0L, 100).contains(EXECUTION_ID),
                "SUSPENDED 行同样不得出现在游标扫描结果里");
    }

    /** 会话两行（根 + 子）、业务轮次（运行中）、可决策卡片、子执行登记。 */
    private void fixture() {
        sessionMapper.insert(SessionPO.builder().id(ROOT_SESSION_ID).rootSessionId(0L).name("根会话").build());
        sessionMapper.insert(SessionPO.builder().id(CHILD_SESSION_ID).rootSessionId(ROOT_SESSION_ID)
                .name("子会话").build());
        chatTurnMapper.insert(ChatTurnPO.builder().id(TURN_ID).version(1L).sessionId(CHILD_SESSION_ID)
                .executionId(EXECUTION_ID).status("RUNNING").createdAt(Instant.now()).build());
        toolCallMapper.insert(ToolCallPO.builder().id(TOOL_CALL_ID).conversationId(CHILD_SESSION_ID)
                .executionId(EXECUTION_ID).toolName("read_file")
                .type(com.summit.dp.toolcall.domain.model.ToolCallType.PROMISE.name())
                .status(com.summit.dp.toolcall.domain.model.ToolCallStatus.PENDING.dbValue())
                .content("{\"kind\":\"PLAN\",\"text\":\"批准一下\"}").version(1L).build());
        assertTrue(registry.registerPendingChild(ROOT_SESSION_ID, CHILD_SESSION_ID, EXECUTION_ID_TEXT, null),
                "前提：子执行必须先登记为「待启动」");
    }

    /** 经真仓储把执行写到终态（先建后终结，与框架的两步保存一致）。 */
    private void saveTerminal(LocalExecutionRepository runtime, ExecutionState state) {
        runtime.save(execution(ExecutionState.CREATED));
        // 前提：本夹具没有运行中的控制槽位，收口才会由 save 的 afterCommit 负责（有槽位时归 unregister）。
        assertFalse(registry.isActive(EXECUTION_ID_TEXT), "前提：本夹具没有运行中的控制槽位");
        runtime.save(execution(state));
    }

    /** 建行 + 转到运行中：取消入口要求执行已经开始。 */
    private void saveRunning(LocalExecutionRepository runtime) {
        runtime.save(execution(ExecutionState.CREATED));
        assertFalse(registry.isActive(EXECUTION_ID_TEXT), "前提：本夹具没有运行中的控制槽位");
        runtime.save(execution(ExecutionState.RUNNING));
    }

    private Execution execution(ExecutionState state) {
        Map<String, Object> attributes = Map.of(
                com.summit.dp.execution.ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                com.summit.dp.execution.ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID));
        return Execution.builder().id(EXECUTION_ID_TEXT).agentId("subAgent")
                .executionState(state)
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID_TEXT)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }

    private LocalExecutionRepository runtime(ExecutionLifecycleProjection projection) {
        return new LocalExecutionRepository(checkpointService, objectMapper, checkpointStore, provider(projection), new MailReceiptFlusherStub());
    }

    private ExecutionLifecycleProjection projection(ToolCallService cards, ChatTurnService turns,
                                                    SubExecutionLifecycle subExecutionLifecycle,
                                                    RuntimeEventPublisher events) {
        return new ExecutionLifecycleProjection(
                provider(mock(ToolCallReadinessService.class)),
                provider(cards),
                provider(subExecutionLifecycle),
                provider(mock(SessionContextUsageProjector.class)),
                provider(new ChatTurnLifecycleProjector(turns)),
                provider(events),
                provider(wakeups),
                provider(executions));
    }

    private ExecutionStartupReaper reaper(LocalExecutionRepository checkpointRepository,
                                         ExecutionLifecycleProjection projection) {
        // 本类验证的是收口脚本与补偿的语义，不是异步策略：让受管执行器当场跑完，断言才是确定的。
        return new ExecutionStartupReaper(executions, resumeTasks,
                mock(ExecutionResumeCoordinator.class), checkpointRepository, projection,
                new com.summit.dp.shared.concurrent.ManagedAsyncExecutor() {
                    @Override
                    public boolean tryExecute(String taskName, Runnable task) {
                        task.run();
                        return true;
                    }
                });
    }

    /** 真实卡片服务：走的是一次独立的收口事务，与生产同构。 */
    private ToolCallService cardsService() {
        ToolCallRepositoryImpl repository = new ToolCallRepositoryImpl(toolCallMapper, objectMapper,
                new CardAvailabilityPolicy(mock(com.summit.dp.toolcall.application.port.ExecutionGateQuery.class)));
        return new ToolCallServiceImpl(repository, new ToolCallConverter(objectMapper),
                new TransactionTemplate(new DataSourceTransactionManager(database)),
                ExecutionCoordination::monitor);
    }

    private ChatTurnService chatTurnService() {
        return new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
    }

    /** 只读事实：一律回库读，不看内存对象。 */
    private Integer pendingFlag() {
        ExecutionPO row = executionMapper.selectById(EXECUTION_ID);
        assertNotNull(row, "执行行必须存在");
        return row.getClosurePending();
    }

    private String turnStatus() {
        ChatTurnPO row = chatTurnMapper.selectById(TURN_ID);
        assertNotNull(row, "轮次行必须存在");
        return row.getStatus();
    }

    private String cardStatus() {
        ToolCallPO row = toolCallMapper.selectById(TOOL_CALL_ID);
        assertNotNull(row, "卡片行必须存在");
        return row.getStatus();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}

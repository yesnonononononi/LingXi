package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.ResumeSupplementCommand;
import com.summit.dp.workflow.application.resume.ResumeSupplementService;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.harness.ResumeSupplementInterceptor;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static com.summit.dp.execution.ExecutionRepositoryTestFactory.provider;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/** 真事务与真实控制槽位共同守住受理原子性和自动唤醒竞争。 */
class ResumeSupplementTest {
    private static final long SESSION_ID = 500L;
    private static final long TURN_ID = 800L;
    private static final String EXECUTION_ID = "900";
    private final ObjectMapper json = new JsonConfig().objectMapper();
    private final ChatTurnService turns = mock(ChatTurnService.class);
    private final SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
    private final ExecutionResumeCoordinator coordinator = mock(ExecutionResumeCoordinator.class);
    private EmbeddedDatabase database;
    private SessionMessageRepositoryImpl messages;
    private ExecutionResumeTaskRepositoryImpl tasks;
    private LocalExecutionRepository executions;
    private ResumeSupplementService service;
    private Execution staleCheckpoint;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("session-response-id-concurrency-schema.sql")
                .addScript("execution-status-schema.sql")
                .addScript("execution-resume-task-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.addMapper(SessionMapper.class);
        configuration.addMapper(SessionMessageMapper.class);
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ExecutionResumeTaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = new SqlSessionTemplate(sessionFactory);
        SessionMapper sessions = template.getMapper(SessionMapper.class);
        sessions.insert(SessionPO.builder().id(SESSION_ID).name("补充测试").build());
        messages = new SessionMessageRepositoryImpl(template.getMapper(SessionMessageMapper.class), sessions);
        tasks = new ExecutionResumeTaskRepositoryImpl(template.getMapper(ExecutionResumeTaskMapper.class));
        executions = ExecutionRepositoryTestFactory.create(template.getMapper(ExecutionMapper.class), json);
        staleCheckpoint = Execution.builder().id(EXECUTION_ID).agentId("main").executionState(ExecutionState.CREATED)
                .createAt(Instant.now()).messages(new ArrayList<>(List.of(UserMessageEntity.from("原提问"))))
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(new HashMap<>(
                                Map.of(ExecutionAttributes.SESSION_ID, SESSION_ID))).build()).build()).build();
        executions.save(staleCheckpoint);
        staleCheckpoint.startChecked();
        staleCheckpoint.suspendChecked();
        executions.save(staleCheckpoint);
        ChatTurn turn = ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).executionId(900L).build();
        when(turns.findByIds(List.of(TURN_ID))).thenReturn(Map.of(TURN_ID, turn));
        when(turns.findByExecutionId(900L)).thenReturn(Optional.of(turn));
        when(coordinator.accept(900L)).thenAnswer(invocation -> {
            tasks.enqueue(900L, 1L, Instant.now());
            return ResumeDisposition.QUEUED;
        });
        service = new ResumeSupplementService(turns, messages, provider(executions), provider(executions),
                resumer, coordinator, new TransactionTemplate(new DataSourceTransactionManager(database)), json);
    }

    @AfterEach
    void shutdown() { database.shutdown(); }

    @Test
    void acceptedMessageAndResumeRequestCommitTogetherWithoutNewTurnOrExecution() throws Exception {
        String id = service.accept(SESSION_ID, command("先别提交"));
        SessionMessage stored = messages.findByResumeRequestId(SESSION_ID, command("").requestId()).orElseThrow();
        assertEquals(id, String.valueOf(stored.getId()));
        assertEquals(TURN_ID, stored.getTurnId());
        assertEquals(SessionMessageType.USER, stored.getType());
        assertNull(stored.getResponseId());
        assertEquals("先别提交", json.readValue(stored.getText(), UserMessageEntity.class).text());
        assertEquals(1, tasks.findByExecutionId(900L).size());
        assertEquals(ExecutionState.SUSPENDED, executions.findById(EXECUTION_ID).orElseThrow().getExecutionState());
    }

    @Test
    void acceptedSupplementAppearsInAuthoritativeViewWithoutReplacingOriginalQuestion() throws Exception {
        messages.save(SessionMessage.builder().id(100L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER).text(json.writeValueAsString(UserMessageEntity.from("原提问"))).build());
        String acceptedId = service.accept(SESSION_ID, command("补充要求"));
        TurnViewService views = new TurnViewService(messages, mock(ChatTurnRepository.class), mock(ToolCallRepository.class),
                new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));
        TurnViewVO view = views.assembleTurnView(null, turns.findByExecutionId(900L).orElseThrow(), 1L).orElseThrow();
        assertEquals("原提问", view.userMessage());
        assertEquals(100L, view.userMessageId());
        assertEquals(acceptedId, String.valueOf(view.resumeSupplements().getFirst().messageId()));
        assertEquals("补充要求", json.valueToTree(view).get("resumeSupplements").get(0).get("text").asText());
    }

    @Test
    void failureAfterEnqueueRollsBackBothRecords() {
        doAnswer(invocation -> {
            tasks.enqueue(900L, 1L, Instant.now());
            throw new IllegalStateException("模拟受理失败");
        }).when(coordinator).accept(900L);
        assertThrows(IllegalStateException.class, () -> service.accept(SESSION_ID, command("不要提交")));
        assertTrue(messages.findBySessionId(SESSION_ID).isEmpty());
        assertTrue(tasks.findByExecutionId(900L).isEmpty());
    }

    @Test
    void concurrentRetriesPersistOnceAndChangedContentIsRejected() throws Exception {
        try (ExecutorService pool = Executors.newFixedThreadPool(4)) {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<String>> futures = new ArrayList<>();
            for (int index = 0; index < 4; index++) futures.add(pool.submit(() -> {
                start.await();
                return service.accept(SESSION_ID, command("保留输入"));
            }));
            start.countDown();
            String id = futures.getFirst().get(10, TimeUnit.SECONDS);
            for (Future<String> future : futures) assertEquals(id, future.get(10, TimeUnit.SECONDS));
        }
        assertEquals(1, messages.findResumeSupplements(SESSION_ID, TURN_ID).size());
        verify(coordinator, times(1)).accept(900L);
        ExecutionControlSignal signal = executions.register(EXECUTION_ID);
        try {
            assertDoesNotThrow(() -> service.accept(SESSION_ID, command("保留输入")));
            assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("另一条要求")));
        } finally { executions.unregister(signal); }
    }

    @Test
    void automaticResumeWinningTheControlSlotRejectsSupplementWithoutHistory() {
        ExecutionControlSignal signal = executions.register(EXECUTION_ID);
        try {
            assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("保留草稿")));
            assertTrue(messages.findBySessionId(SESSION_ID).isEmpty());
            verify(coordinator, never()).accept(anyLong());
        } finally { executions.unregister(signal); }
    }

    @Test
    void registrationCannotPassBeforeTheAdmissionTransactionCommits() throws Exception {
        CountDownLatch beforeCommit = new CountDownLatch(1);
        CountDownLatch releaseCommit = new CountDownLatch(1);
        CountDownLatch registrationStarted = new CountDownLatch(1);
        doAnswer(invocation -> {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void beforeCommit(boolean readOnly) {
                    beforeCommit.countDown();
                    try { assertTrue(releaseCommit.await(5, TimeUnit.SECONDS)); }
                    catch (InterruptedException error) { throw new IllegalStateException(error); }
                }
            });
            return ResumeDisposition.QUEUED;
        }).when(coordinator).accept(900L);
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            Future<String> accepted = pool.submit(() -> service.accept(SESSION_ID, command("提交之前不可恢复")));
            assertTrue(beforeCommit.await(5, TimeUnit.SECONDS));
            Future<ExecutionControlSignal> registered = pool.submit(() -> {
                registrationStarted.countDown();
                ExecutionControlSignal signal = executions.register(EXECUTION_ID);
                assertEquals(1, messages.findResumeSupplements(SESSION_ID, TURN_ID).size(),
                        "取得控制槽位时，补充要求必须已经提交");
                return signal;
            });
            assertTrue(registrationStarted.await(5, TimeUnit.SECONDS));
            try {
                assertThrows(TimeoutException.class, () -> registered.get(150, TimeUnit.MILLISECONDS));
            } finally { releaseCommit.countDown(); }
            accepted.get(5, TimeUnit.SECONDS);
            executions.unregister(registered.get(5, TimeUnit.SECONDS));
        }
    }

    @Test
    void staleCheckpointReceivesCommittedSupplementsOnceAndCursorSurvivesCheckpointReload() throws Exception {
        service.accept(SESSION_ID, command("新增的验收项"));
        ResumeSupplementInterceptor interceptor = new ResumeSupplementInterceptor(messages, turns, json);
        List<Message> appended = new ArrayList<>();
        LoopContext context = context(staleCheckpoint, appended);
        interceptor.onBeforeModelInvoke(context);
        assertEquals(List.of("新增的验收项"), appended.stream().map(Message::text).toList());
        assertEquals(-850, interceptor.order());
        assertFalse(interceptor.catchErr());
        staleCheckpoint.getMessages().addAll(appended);
        executions.save(staleCheckpoint);
        Execution reloaded = executions.findById(EXECUTION_ID).orElseThrow();
        List<Message> replayed = new ArrayList<>();
        interceptor.onBeforeModelInvoke(context(reloaded, replayed));
        assertTrue(replayed.isEmpty());
        assertEquals("新增的验收项", reloaded.getMessages().getLast().text());
        assertEquals(1, messages.findBySessionId(SESSION_ID).size());
    }

    @Test
    void unresolvedCardsAndEndedOrForeignTurnsCannotAcceptSupplements() {
        when(resumer.hasUnresolvedSlot(900L)).thenReturn(true);
        assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("有未决卡片")));
        when(resumer.hasUnresolvedSlot(900L)).thenReturn(false);
        staleCheckpoint.resumeChecked();
        staleCheckpoint.completeChecked();
        executions.save(staleCheckpoint);
        assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("执行已结束")));
        assertThrows(ClientException.class, () -> service.accept(501L, command("别的会话")));
        assertTrue(messages.findBySessionId(SESSION_ID).isEmpty());
    }

    @Test
    void invalidSupplementIsRejectedBeforePersistenceAndBrokenStoredContentCannotBeSilentlySkipped() {
        assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("  ")));
        assertThrows(ClientException.class, () -> service.accept(SESSION_ID, command("长".repeat(20001))));
        assertThrows(ClientException.class, () -> service.accept(SESSION_ID, new ResumeSupplementCommand(TURN_ID, "bad", "内容")));
        assertTrue(messages.findBySessionId(SESSION_ID).isEmpty());
        messages.save(SessionMessage.builder().id(999L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER).resumeRequestId("broken-request-id").text("坏数据").build());
        ResumeSupplementInterceptor interceptor = new ResumeSupplementInterceptor(messages, turns, json);
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeModelInvoke(context(staleCheckpoint, new ArrayList<>())));
    }

    private ResumeSupplementCommand command(String input) {
        return new ResumeSupplementCommand(TURN_ID, "d58322cb-4ef9-4f32-a4cf-1e10bb51b937", input);
    }

    private LoopContext context(Execution execution, List<Message> appended) {
        return new LoopContext(LoopMessages.builder().execution(execution).build(),
                new ExecutionControlSignal(EXECUTION_ID), 0, appended::addAll);
    }
}

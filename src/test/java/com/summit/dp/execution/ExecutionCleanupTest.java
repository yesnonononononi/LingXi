package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.agent.AgentRequest;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.api.controller.ExecutionCleanupController;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionCleanupService.CleanupResult;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ResendTargetResolver;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 使用真实 Mapper 验证清理边界、并发重查与独立回收事务。 */
@SpringJUnitConfig(ExecutionCleanupTest.Config.class)
class ExecutionCleanupTest {
    @Autowired private ExecutionCleanupService service;
    @Autowired private ExecutionRepository repository;
    @Autowired private ExecutionActivity activity;
    @Autowired private SqlSessionTemplate sql;
    @Autowired private PlatformTransactionManager transactionManager;
    private ExecutionMapper executions;
    private SessionMapper sessions;
    private ChatTurnMapper turns;
    private ToolCallMapper calls;
    private ExecutionResumeTaskMapper resumes;
    private TaskMapper tasks;

    @BeforeEach
    void prepare() {
        executions = sql.getMapper(ExecutionMapper.class);
        sessions = sql.getMapper(SessionMapper.class);
        turns = sql.getMapper(ChatTurnMapper.class);
        calls = sql.getMapper(ToolCallMapper.class);
        resumes = sql.getMapper(ExecutionResumeTaskMapper.class);
        tasks = sql.getMapper(TaskMapper.class);
        calls.delete(null);
        resumes.delete(null);
        tasks.delete(null);
        turns.delete(null);
        executions.delete(null);
        sessions.delete(null);
        reset(repository, activity);
    }

    @Test
    void cleanupPreservesHistoryAndEveryNonterminalState() {
        insertSession(10L);
        insertExecution(100L, ExecutionStatusCodes.COMPLETED);
        insertTurn(20L, 100L);
        for (int status : List.of(0, 1, 2, 6)) insertExecution(110L + status, status);
        for (int status : List.of(3, 4, 5)) insertExecution(120L + status, status);

        assertEquals(3L, service.preview().executionCount());
        CleanupResult result = service.cleanup();

        assertEquals(3L, result.deletedCount());
        assertEquals(0L, result.remainingCount());
        assertNotNull(executions.selectById(100L));
        assertNotNull(turns.selectById(20L));
        for (int status : List.of(0, 1, 2, 6)) assertNotNull(executions.selectById(110L + status));
        assertEquals(0L, service.cleanup().deletedCount());
    }

    @Test
    void deletedSessionAndRolledBackTurnsLeaveReclaimableExecutions() {
        insertSession(10L);
        insertExecution(100L, 3);
        insertTurn(20L, 100L);
        sessions.deleteById(10L);
        insertSession(11L);
        insertExecution(101L, 4);

        assertEquals(2L, service.cleanup().deletedCount());
        assertNull(executions.selectById(100L));
        assertNull(executions.selectById(101L));
        assertNotNull(turns.selectById(20L), "本入口只回收执行，不改写其他模块数据");
        assertNotNull(sessions.selectById(11L));
    }

    @ParameterizedTest
    @ValueSource(strings = {"card", "ready", "failedResume", "runningTask", "finishedTask"})
    void anyBusinessReferenceProtectsExecution(String reference) {
        insertExecution(100L, 3);
        switch (reference) {
            case "card" -> calls.insert(ToolCallPO.builder().id("call-a").conversationId(10L)
                    .executionId(100L).toolName("audit").type("EXECUTE").status("completed").build());
            case "ready", "failedResume" -> resumes.insert(ExecutionResumeTaskPO.builder()
                    .executionId(100L).generation(0L)
                    .state(reference.equals("ready") ? "READY" : "FAILED").build());
            default -> {
                TaskPO task = new TaskPO();
                task.setId(30L);
                task.setSessionId(10L);
                task.setTurnId(20L);
                task.setExecutionId(100L);
                task.setCommand("audit");
                task.setStatus(reference.equals("runningTask") ? "RUNNING" : "SUCCESS");
                task.setCreateAt(Instant.now());
                tasks.insert(task);
            }
        }
        assertEquals(0L, service.preview().executionCount());
        assertEquals(0L, service.cleanup().deletedCount());
        assertNotNull(executions.selectById(100L));
    }

    @Test
    void activeControlSlotSurvivesEvenAfterTerminalCheckpointWasSaved() {
        insertExecution(100L, 3);
        when(activity.isActive("100")).thenReturn(true);
        assertEquals(0L, service.cleanup().deletedCount());
        assertNotNull(executions.selectById(100L));
        when(activity.isActive("100")).thenReturn(false);
        assertEquals(1L, service.cleanup().deletedCount());
    }

    @Test
    void deletionRechecksReferencesStatusAndVersionAfterSelection() {
        insertSession(10L);
        for (long id : List.of(100L, 101L, 102L)) insertExecution(id, 3);
        List<Execution> candidates = repository.findReclaimable(0L, 200);
        assertEquals(3, candidates.size());
        assertNull(candidates.getFirst().getSnapshot(), "候选查询不读取快照正文");
        insertTurn(20L, 100L);
        executions.update(null, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, 101L)
                .set(ExecutionPO::getStatus, ExecutionStatusCodes.SUSPENDED));
        executions.update(null, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, 102L)
                .set(ExecutionPO::getVersion, 2L));
        for (Execution candidate : candidates) {
            assertFalse(repository.deleteReclaimable(candidate.getId(), candidate.getVersion()));
            assertNotNull(executions.selectById(candidate.getId()));
        }
    }

    @Test
    void cleanupPagesPastFirstBatchWithoutReadingSnapshots() {
        for (long id = 1L; id <= 205L; id++) insertExecution(id, 3);
        CleanupResult result = service.cleanup();
        assertEquals(205L, result.deletedCount());
        assertEquals(0L, executions.selectCount(null));
    }

    @Test
    void failurePreservesCommittedDeletionsAndLeavesRemainingCandidates() {
        insertExecution(100L, 3);
        insertExecution(101L, 3);
        AtomicInteger attempts = new AtomicInteger();
        doAnswer(invocation -> {
            if (attempts.incrementAndGet() == 2) throw new IllegalStateException("模拟删除失败");
            return invocation.callRealMethod();
        }).when(repository).deleteReclaimable(anyLong(), anyLong());

        assertThrows(IllegalStateException.class, service::cleanup);
        assertNull(executions.selectById(100L), "已完成的回收必须及时提交，不能积累整次清理的回滚日志");
        assertNotNull(executions.selectById(101L));
        assertEquals(1L, service.preview().executionCount());
    }

    @Test
    void failureRollsBackCurrentDeletion() {
        insertExecution(100L, 3);
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new IllegalStateException("模拟删除后的事务失败");
        }).when(repository).deleteReclaimable(anyLong(), anyLong());

        assertThrows(IllegalStateException.class, service::cleanup);
        assertNotNull(executions.selectById(100L), "单条回收失败仍须完整回滚");
    }

    @Test
    void cleanupCommitsIndependentlyFromCallerTransaction() {
        insertExecution(100L, 3);
        insertExecution(101L, 3);
        TransactionTemplate caller = new TransactionTemplate(transactionManager);
        caller.executeWithoutResult(status -> {
            assertEquals(2L, service.preview().executionCount());
            CleanupResult result = service.cleanup();
            assertEquals(2L, result.deletedCount());
            assertEquals(0L, result.remainingCount(), "清理结果必须重新计数，不能使用调用方缓存");
            status.setRollbackOnly();
        });

        assertEquals(0L, executions.selectCount(null), "调用方不能把独立回收合并成长事务");
    }

    @Test
    void concurrentCleanupCountsEachExecutionOnlyOnce() throws Exception {
        insertExecution(100L, 3);
        insertExecution(101L, 3);
        CyclicBarrier selected = new CyclicBarrier(2);
        doAnswer(invocation -> {
            Object result = invocation.callRealMethod();
            if (invocation.<Long>getArgument(0) == 0L) selected.await(10, TimeUnit.SECONDS);
            return result;
        }).when(repository).findReclaimable(anyLong(), anyInt());
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            Future<CleanupResult> first = pool.submit(service::cleanup);
            Future<CleanupResult> second = pool.submit(service::cleanup);
            assertEquals(2L, first.get(15, TimeUnit.SECONDS).deletedCount()
                    + second.get(15, TimeUnit.SECONDS).deletedCount());
        }
        assertEquals(0L, executions.selectCount(null));
    }

    @Test
    void cleanupKeepsCompactedResendBaselineIntact() throws Exception {
        insertSession(10L);
        insertExecution(100L, 3);
        insertTurn(20L, 100L);
        insertExecution(101L, 3);
        ObjectMapper mapper = new JsonConfig().objectMapper();
        List<Message> history = List.of(SystemMessageEntity.builder().text("压缩后的历史基线").build(),
                UserMessageEntity.from("目标提问"), SystemMessageEntity.builder().text("后续回答").build());
        ObjectNode snapshotTree = mapper.createObjectNode().put("id", "100");
        snapshotTree.set("agentRequest", mapper.valueToTree(AgentRequest.builder().build()));
        snapshotTree.set("messages", mapper.valueToTree(history));
        String snapshot = mapper.writeValueAsString(snapshotTree);
        executions.update(null, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, 100L)
                .set(ExecutionPO::getSnapshot, snapshot));
        SessionMessageQueryService messages = mock(SessionMessageQueryService.class);
        ChatTurnService chatTurns = mock(ChatTurnService.class);
        when(messages.findByMessageId(30L)).thenReturn(Result.success(SessionMessageVO.builder()
                .id(30L).turnId(20L).sessionId(10L).type("USER").build()));
        when(chatTurns.findByIds(List.of(20L))).thenReturn(Map.of(20L,
                ChatTurn.builder().id(20L).sessionId(10L).executionId(100L).build()));
        ResendTargetResolver resolver = new ResendTargetResolver(messages, chatTurns,
                new ExecutionQueryServiceImpl(repository), mapper);

        assertEquals(1L, service.cleanup().deletedCount());
        ResendTargetResolver.ResendTarget target = resolver.resolve(
                new ChatCommand("修改提问", 10L, null, null, 30L, null, false, List.of(), List.of()));
        assertEquals(mapper.writeValueAsString(history.subList(0, 1)), mapper.writeValueAsString(target.baseline()));
        assertEquals(snapshot, executions.selectById(100L).getSnapshot());
    }

    @Test
    void endpointsPreviewWithoutDeletingAndReturnAuthoritativeCountsAsStrings() throws Exception {
        insertExecution(100L, 3);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ExecutionCleanupController(service))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();
        mvc.perform(get("/execution/cleanup/preview")).andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(1)).andExpect(jsonPath("$.data.executionCount").value("1"));
        assertNotNull(executions.selectById(100L));
        mvc.perform(post("/execution/cleanup")).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.deletedCount").value("1"))
                .andExpect(jsonPath("$.data.remainingCount").value("0"));
    }

    private void insertSession(long id) {
        sessions.insert(SessionPO.builder().id(id).name("清理测试").rootSessionId(0L).build());
    }

    private void insertTurn(long id, long executionId) {
        turns.insert(ChatTurnPO.builder().id(id).sessionId(10L).executionId(executionId).status("COMPLETED").build());
    }

    private void insertExecution(long id, int status) {
        ExecutionPO execution = new ExecutionPO();
        execution.setId(id);
        execution.setSessionId(10L);
        execution.setVersion(1L);
        execution.setStatus(status);
        execution.setSnapshot("用于检测误删的快照");
        executions.insert(execution);
    }

    @Configuration
    @EnableTransactionManagement
    static class Config {
        @Bean(destroyMethod = "shutdown") EmbeddedDatabase database() {
            return new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                    .setName("execution-cleanup-" + UUID.randomUUID() + ";MODE=MySQL")
                    .addScript("file:./init.sql").build();
        }

        @Bean PlatformTransactionManager transactionManager(EmbeddedDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean SqlSessionTemplate sql(EmbeddedDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            for (Class<?> mapper : List.of(ExecutionMapper.class, SessionMapper.class, ChatTurnMapper.class,
                    ToolCallMapper.class, ExecutionResumeTaskMapper.class, TaskMapper.class)) configuration.addMapper(mapper);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            return new SqlSessionTemplate(factory.getObject());
        }

        @Bean ExecutionRepository repository(SqlSessionTemplate sql) {
            return spy(new ExecutionRepositoryImpl(sql.getMapper(ExecutionMapper.class)));
        }

        @Bean ExecutionActivity activity() { return mock(ExecutionActivity.class); }

        @Bean ExecutionReclaimService reclaimer(ExecutionRepository repository, ExecutionActivity activity,
                                                PlatformTransactionManager transactionManager) {
            return new ExecutionReclaimService(repository, activity, transactionManager);
        }

        @Bean ExecutionCleanupService cleanupService(ExecutionRepository repository, ExecutionReclaimService reclaimer) {
            return new ExecutionCleanupService(repository, reclaimer);
        }
    }
}

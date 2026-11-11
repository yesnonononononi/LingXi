package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.api.controller.ExecutionCleanupController;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.support.NoFileRecords;
import com.summit.dp.execution.application.service.ExecutionCleanupService.CleanupResult;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
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
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
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
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import com.summit.core.agent.ContextSpec;

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

    @Autowired private LocalFileCheckpointStore checkpointStore;
    @Autowired private Path checkpointDataDir;
    /** 每个插入的执行对应发布出去的那份正文文件标识，供「文件是否还在」的断言使用。 */
    private final Map<Long, String> checkpointFiles = new java.util.HashMap<>();
    private static final ObjectMapper CHECKPOINT_MAPPER = new JsonConfig().objectMapper();

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
        // 每个用例都从干净的检查点目录开始：上一轮留下的正文不该影响引用保护判定。
        clearCheckpointDirectory();
        checkpointFiles.clear();
        reset(repository, activity);
    }

    private void clearCheckpointDirectory() {
        if (!java.nio.file.Files.isDirectory(checkpointDataDir)) return;
        try (java.util.stream.Stream<Path> paths = java.nio.file.Files.walk(checkpointDataDir)) {
            paths.sorted(java.util.Comparator.reverseOrder())
                    .filter(path -> !path.equals(checkpointDataDir))
                    .forEach(path -> {
                        try {
                            java.nio.file.Files.deleteIfExists(path);
                        } catch (java.io.IOException ignored) {
                            // 临时目录由系统兜底清理，不掩盖用例失败。
                        }
                    });
        } catch (java.io.IOException ignored) {
            // 同上。
        }
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
        // 保护的执行，其正文文件必须一份都不少（运行中 / 挂起 / 审批中 / 后台任务 / 历史重发）。
        assertTrue(checkpointFileExists(100L), "历史重发引用的正文必须保留");
        for (int status : List.of(0, 1, 2, 6)) {
            assertTrue(checkpointFileExists(110L + status), "非终态执行的正文必须保留: status=" + status);
        }
        // 已结束且无引用：数据库行与正文文件一起消失。
        for (int status : List.of(3, 4, 5)) {
            assertNull(executions.selectById(120L + status));
            assertFalse(checkpointFileExists(120L + status), "已回收执行的正文必须一起删掉: status=" + status);
        }
    }

    /** 在途写入（已发布但事务未定）的正文不能被清理删掉。 */
    @Test
    void cleanupNeverDeletesInFlightCheckpointFiles() {
        insertSession(10L);
        insertExecution(100L, ExecutionStatusCodes.COMPLETED);
        ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin("100");
        try {
            CHECKPOINT_MAPPER.writeValue(writer.stream(), Map.of("id", "100"));
            writer.publish();
            String inFlightFile = writer.fileId();

            assertEquals(1L, service.cleanup().deletedCount());

            assertNull(executions.selectById(100L));
            assertTrue(java.nio.file.Files.isRegularFile(checkpointDataDir.resolve("checkpoints")
                            .resolve("100").resolve(inFlightFile + ".json")),
                    "在途写入的正文不能被清理删除");
        } catch (java.io.IOException e) {
            throw new IllegalStateException("写入测试检查点失败", e);
        } finally {
            writer.complete();
        }
    }

    /** 同一入口顺带回收：删文件失败留下的旧文件、行已消失的孤儿文件、未完成的 .part；不碰 images/。 */
    @Test
    void cleanupReclaimsLeftoverOrphanAndTemporaryFilesButLeavesOtherDirectoriesAlone()
            throws java.io.IOException {
        insertSession(10L);
        insertExecution(100L, ExecutionStatusCodes.COMPLETED);
        insertTurn(20L, 100L);

        Path executionDir = java.nio.file.Files.createDirectories(
                checkpointDataDir.resolve("checkpoints").resolve("100"));
        // 旧文件：曾被替换但当时没删掉（不是库内权威引用，也不是在途）。
        String leftover = "11111111111111111111111111111111";
        java.nio.file.Files.writeString(executionDir.resolve(leftover + ".json"), "{\"old\":true}");
        // 未完成的临时文件。
        String temporary = "22222222222222222222222222222222-abc.part";
        java.nio.file.Files.writeString(executionDir.resolve(temporary), "{");
        // 孤儿目录：库行早已不存在。
        Path orphanDir = java.nio.file.Files.createDirectories(
                checkpointDataDir.resolve("checkpoints").resolve("999"));
        String orphan = "33333333333333333333333333333333";
        java.nio.file.Files.writeString(orphanDir.resolve(orphan + ".json"), "{\"orphan\":true}");
        // 用户数据目录里的无关内容：一律不碰。
        Path images = java.nio.file.Files.createDirectories(checkpointDataDir.resolve("images"));
        Path image = java.nio.file.Files.writeString(images.resolve("cat.png"), "not-a-real-image");

        service.cleanup();

        assertTrue(checkpointFileExists(100L), "被历史引用的正文必须保留");
        assertTrue(java.nio.file.Files.notExists(executionDir.resolve(leftover + ".json")), "旧文件应被回收");
        assertTrue(java.nio.file.Files.notExists(executionDir.resolve(temporary)), ".part 临时文件应被回收");
        assertTrue(java.nio.file.Files.notExists(orphanDir.resolve(orphan + ".json")), "孤儿文件应被回收");
        assertTrue(java.nio.file.Files.isRegularFile(image), "数据目录里的其它内容一律不碰");
    }

    /**
     * 正文删完以后执行目录必须一起消失：否则每轮执行留一个空目录，{@code checkpoints/} 会无上限堆积，
     * 之后的清理预算全被空目录吃掉，孤儿文件反而轮不到。
     */
    @Test
    void cleanupRemovesEmptiedExecutionDirectoriesAndKeepsProtectedOnes() throws java.io.IOException {
        insertExecution(900001L, ExecutionStatusCodes.COMPLETED);
        insertExecution(900002L, ExecutionStatusCodes.SUSPENDED);
        Path orphanDir = java.nio.file.Files.createDirectories(
                checkpointDataDir.resolve("checkpoints").resolve("900003"));
        java.nio.file.Files.writeString(orphanDir.resolve("44444444444444444444444444444444.json"),
                "{\"orphan\":true}");
        Path images = java.nio.file.Files.createDirectories(checkpointDataDir.resolve("images"));

        assertEquals(1L, service.cleanup().deletedCount());

        assertNull(executions.selectById(900001L));
        assertFalse(executionDirectoryExists(900001L), "可回收执行的行删光后，空执行目录必须一起回收");
        assertNotNull(executions.selectById(900002L));
        assertTrue(checkpointFileExists(900002L), "挂起执行的正文必须保留");
        assertTrue(executionDirectoryExists(900002L), "非空执行目录不能被当成空目录删掉");
        assertFalse(executionDirectoryExists(900003L), "孤儿文件回收后留下的空目录也要一起回收");
        assertEquals(1L, checkpointDirectoryCount(), "剩下的只该是被保护执行那一个目录");
        assertTrue(java.nio.file.Files.isDirectory(images), "数据目录里的其它内容一律不碰");
    }

    /** 「保存 → 清理」循环不能越攒越多空目录：每一轮结束后 checkpoints 下必须是空的。 */
    @Test
    void repeatedSaveAndCleanupCyclesDoNotAccumulateExecutionDirectories() {
        for (int cycle = 0; cycle < 5; cycle++) {
            long executionId = 950000L + cycle;
            insertExecution(executionId, ExecutionStatusCodes.COMPLETED);
            assertEquals(1L, service.cleanup().deletedCount());
            assertEquals(0L, checkpointDirectoryCount(),
                    "保存→清理循环不能让空执行目录堆积, cycle=" + cycle);
        }
    }

    /**
     * 只剩孤儿文件（没有可回收的行）时，预览必须把「文件侧还需扫描」单独报出来。
     *
     * <p>否则界面会按 executionCount=0 把清理按钮禁掉，孤儿 JSON 与 .part 永远没机会被回收，
     * 跨调用游标也推不动。</p>
     */
    @Test
    void previewSeparatesNoReclaimableRowsFromFilesStillNeedingScan() throws java.io.IOException {
        Path orphanDir = java.nio.file.Files.createDirectories(
                checkpointDataDir.resolve("checkpoints").resolve("999"));
        String orphan = "55555555555555555555555555555555";
        java.nio.file.Files.writeString(orphanDir.resolve(orphan + ".json"), "{\"orphan\":true}");
        java.nio.file.Files.writeString(orphanDir.resolve(orphan + "-unfinished.part"), "{");

        ExecutionCleanupService.Preview withFiles = service.preview();
        assertEquals(0L, withFiles.executionCount(), "没有可回收的行");
        assertTrue(withFiles.filesNeedScan(), "仍有孤儿文件与 .part，必须报告文件侧需扫描");

        service.cleanup();

        ExecutionCleanupService.Preview afterCleanup = service.preview();
        assertEquals(0L, afterCleanup.executionCount());
        assertFalse(afterCleanup.filesNeedScan(), "文件侧清空后（含空目录回收）不再需要扫描");
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
        // 沿用既有规则：会话删掉后，它那些执行的重发入口也随之消失，正文文件同样不再保留。
        assertFalse(checkpointFileExists(100L), "会话已删 ⇒ 不再有重发需求，正文一并回收");
        assertFalse(checkpointFileExists(101L));
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
        assertNull(candidates.getFirst().getSnapshotFile(), "候选查询不读取快照正文");
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
        // 正文在文件里，库里只留文件标识：先发布第 100 轮自己的检查点文件，再把标识写进那一行。
        java.nio.file.Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
        String fileId = publishCheckpoint(store, mapper, checkpointOf("100", history));
        executions.update(null, Wrappers.<ExecutionPO>lambdaUpdate().eq(ExecutionPO::getId, 100L)
                .set(ExecutionPO::getSnapshotFile, fileId));
        SessionMessageQueryService messages = mock(SessionMessageQueryService.class);
        ChatTurnService chatTurns = mock(ChatTurnService.class);
        when(messages.findByMessageId(30L)).thenReturn(Result.success(SessionMessageVO.builder()
                .id(30L).turnId(20L).sessionId(10L).type("USER").build()));
        when(chatTurns.findByIds(List.of(20L))).thenReturn(Map.of(20L,
                ChatTurn.builder().id(20L).sessionId(10L).executionId(100L).build()));
        // 消费者侧只认「执行」对象：仓储按库内标识流式读文件，重发不再接触整段 JSON 字符串。
        LocalExecutionRepository runtime = ExecutionRepositoryTestFactory.create(executions, mapper, dataDir);
        ResendTargetResolver resolver = new ResendTargetResolver(messages, chatTurns, runtime);

        assertEquals(1L, service.cleanup().deletedCount());
        ResendTargetResolver.ResendTarget target = resolver.resolve(
                new ChatCommand("修改提问", 10L, null, null, 30L, null, false, List.of(), List.of()));
        assertEquals(mapper.writeValueAsString(history.subList(0, 1)), mapper.writeValueAsString(target.baseline()));
        assertEquals(fileId, executions.selectById(100L).getSnapshotFile());
    }

    /** 目标轮次自己的检查点：基线就取它自己的历史，绝不回退到会话最新一轮。 */
    private static com.summit.core.agent.Execution checkpointOf(String executionId, List<Message> history) {
        return com.summit.core.agent.Execution.builder()
                .id(executionId)
                .executionState(com.summit.core.agent.ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder().contextSpec(ContextSpec.builder().context(history).build()).build())
                .messages(history)
                .build();
    }

    /** 走存储端口发布一份真实检查点文件，返回库内该存的权威文件标识。 */
    private static String publishCheckpoint(LocalFileCheckpointStore store, ObjectMapper mapper,
                                           com.summit.core.agent.Execution execution) throws Exception {
        com.summit.dp.execution.application.port.ExecutionCheckpointStore.CheckpointWriter writer =
                store.begin(execution.getId());
        try {
            mapper.writeValue(writer.stream(), execution);
            writer.publish();
            return writer.fileId();
        } finally {
            writer.complete();
        }
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
        execution.setSnapshotFile(publishCheckpoint(id));
        executions.insert(execution);
    }

    /** 走存储端口发布一份真实正文文件，返回库内该存的权威文件标识。 */
    private String publishCheckpoint(long executionId) {
        try {
            ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin(Long.toString(executionId));
            String fileId;
            try {
                CHECKPOINT_MAPPER.writeValue(writer.stream(), Map.of("id", Long.toString(executionId)));
                writer.publish();
                fileId = writer.fileId();
            } finally {
                writer.complete();
            }
            checkpointFiles.put(executionId, fileId);
            return fileId;
        } catch (java.io.IOException e) {
            throw new IllegalStateException("写入测试检查点失败", e);
        }
    }

    /** 该执行那份已发布的正文文件还在不在（直接看文件系统，不看库）。 */
    private boolean checkpointFileExists(long executionId) {
        String fileId = checkpointFiles.get(executionId);
        return fileId != null && java.nio.file.Files.isRegularFile(checkpointDataDir.resolve("checkpoints")
                .resolve(Long.toString(executionId)).resolve(fileId + ".json"));
    }

    /** 该执行的检查点目录还在不在。 */
    private boolean executionDirectoryExists(long executionId) {
        return java.nio.file.Files.isDirectory(checkpointDataDir.resolve("checkpoints")
                .resolve(Long.toString(executionId)));
    }

    /** {@code checkpoints/} 下现存的执行目录数。 */
    private long checkpointDirectoryCount() {
        Path checkpoints = checkpointDataDir.resolve("checkpoints");
        if (!java.nio.file.Files.isDirectory(checkpoints)) return 0L;
        try (java.util.stream.Stream<Path> children = java.nio.file.Files.list(checkpoints)) {
            return children.filter(java.nio.file.Files::isDirectory).count();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("枚举检查点目录失败", e);
        }
    }

    @Configuration
    @EnableTransactionManagement
    static class Config {
        @Bean(destroyMethod = "shutdown") H2TestDatabase database() {
            return H2TestDatabase.create("ExecutionCleanupTest");
        }

        @Bean PlatformTransactionManager transactionManager(H2TestDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean Path checkpointDataDir() {
            return ExecutionRepositoryTestFactory.tempDataDir();
        }

        @Bean SqlSessionTemplate sql(H2TestDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            MyBatisTypeHandlers.registerAll(configuration);
            for (Class<?> mapper : List.of(ExecutionMapper.class, SessionMapper.class, ChatTurnMapper.class,
                    ToolCallMapper.class, ExecutionResumeTaskMapper.class, TaskMapper.class)) configuration.addMapper(mapper);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            return H2TestDatabase.sqlSession(factory.getObject());
        }

        @Bean ExecutionRepository repository(SqlSessionTemplate sql) {
            return spy(new ExecutionRepositoryImpl(sql.getMapper(ExecutionMapper.class)));
        }

        @Bean ExecutionActivity activity() { return mock(ExecutionActivity.class); }

        /** 检查点正文落在系统临时目录：用例要在真实文件上验证「库先删、文件后删」。 */
        @Bean LocalFileCheckpointStore checkpointStore(Path checkpointDataDir) {
            return new LocalFileCheckpointStore(checkpointDataDir.toString(),
                    new JsonConfig().objectMapper(), 0L);
        }

        @Bean ExecutionCheckpointMaintenance maintenance(ExecutionRepository repository,
                                                         LocalFileCheckpointStore checkpointStore) {
            return new LocalCheckpointMaintenance(checkpointStore, repository);
        }

        @Bean ExecutionReclaimService reclaimer(ExecutionRepository repository, ExecutionActivity activity,
                                                ExecutionCheckpointMaintenance maintenance,
                                                PlatformTransactionManager transactionManager) {
            return new ExecutionReclaimService(repository, activity, maintenance, transactionManager);
        }

        @Bean ExecutionCleanupService cleanupService(ExecutionRepository repository, ExecutionReclaimService reclaimer,
                                                     ExecutionCheckpointMaintenance maintenance) {
            return new ExecutionCleanupService(repository, reclaimer, maintenance, new NoFileRecords());
        }
    }
}

package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 检查点存储端口的守卫用例：流式写入、原子发布、在途登记、无正文缓存、副本隔离。
 *
 * <p>这里用「假行存储 + 真实文件」组合：文件是真的（临时目录里的真实文件），
 * 数据库行用一个 Map 代替 —— 这样能精确控制「库内权威引用指向哪个文件」，
 * 又不必为了提高覆盖率启一个 SQLite 文件库。</p>
 */
class LocalFileCheckpointStoreTest {

    /** 故意用 spy：保存路径有没有偷偷生成整段字符串，只能靠拦截 ObjectMapper 才看得见。 */
    private final ObjectMapper mapper = spy(new JsonConfig().objectMapper());
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
    private final LocalFileCheckpointStore checkpointStore =
            new LocalFileCheckpointStore(dataDir.toString(), mapper);
    /** 假的 execution 表：id → 那一行（含检查点文件标识）。 */
    private final Map<Long, ExecutionPO> rows = new ConcurrentHashMap<>();

    private final LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(
            new ExecutionCheckpointService(new ExecutionRepositoryImpl(persistence),
                    mock(ApplicationEventPublisher.class)),
            mapper,
            checkpointStore,
            ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());

    @BeforeEach
    void prepareFakeTable() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"),
                ExecutionPO.class);
        when(persistence.update(any(ExecutionPO.class), any())).thenAnswer(invocation -> {
            ExecutionPO row = invocation.getArgument(0);
            rows.put(row.getId(), row);
            return 1;
        });
        when(persistence.selectById(anyLong())).thenAnswer(invocation ->
                rows.get(invocation.<Long>getArgument(0)));
        when(persistence.selectOne(any())).thenAnswer(invocation -> rows.values().stream().findFirst().orElse(null));
    }

    @Test
    void cancellationCheckpointSurvivesAnInterruptedThread() {
        seedRow(305L, ExecutionStatusCodes.RUNNING, 1L, null);
        Execution cancelled = suspended("305", List.of(UserMessageEntity.from("取消前的完整上下文")));
        cancelled.cancelChecked();
        Thread.currentThread().interrupt();
        try {
            assertDoesNotThrow(() -> repository.save(cancelled));
            assertTrue(Thread.currentThread().isInterrupted(), "保存不能吞掉取消信号");
        } finally {
            Thread.interrupted();
        }
        assertEquals(ExecutionStatusCodes.CANCELLED, rows.get(305L).getStatus());
        Execution restored = repository.findById("305").orElseThrow();
        assertEquals(ExecutionState.CANCELLED, restored.getExecutionState());
        assertEquals("取消前的完整上下文", restored.getMessages().getFirst().text());
    }

    @Test
    void interruptBetweenWritingAndPublishingStillPublishesDurableContent() throws IOException {
        ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin("305");
        mapper.writeValue(writer.stream(), Map.of("message", "已写入的上下文"));
        Thread.currentThread().interrupt();
        try {
            assertDoesNotThrow(writer::publish);
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
            writer.complete();
        }
        assertEquals("已写入的上下文", checkpointStore.read("305", writer.fileId(), Map.class).get("message"));
        assertFalse(checkpointStore.isInFlight("305", writer.fileId()));
    }

    @Test
    void interruptedFinalizationCanReadTheCommittedCheckpoint() {
        String fileId = publish("305", suspended("305", List.of(UserMessageEntity.from("收尾读取"))));
        Thread.currentThread().interrupt();
        try {
            Execution restored = assertDoesNotThrow(() -> checkpointStore.read("305", fileId, Execution.class));
            assertEquals("收尾读取", restored.getMessages().getFirst().text());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    /** 保存路径绝不产生完整 JSON 字符串：这是后续 512 MiB 堆 OOM 守卫的基础。 */
    @Test
    void savingStreamsTheCheckpointWithoutBuildingAWholeDocumentString() throws Exception {
        seedRow(305L, ExecutionStatusCodes.RUNNING, 1L, null);

        repository.save(suspended("305", List.of(UserMessageEntity.from("hi"))));

        verify(mapper, never()).writeValueAsString(any());
        verify(mapper, never()).writeValueAsBytes(any());
        verify(mapper, atLeastOnce()).writeValue(any(OutputStream.class), any());

        String fileId = rows.get(305L).getSnapshotFile();
        assertTrue(fileId.matches("[0-9a-f]{32}"), "库内该存文件标识，实际: " + fileId);
        assertEquals("hi", checkpointStore.read("305", fileId, Execution.class).getMessages().getFirst().text());
    }

    /** 已发布但事务未定的文件：清理必须跳过；事务定了才允许回收。 */
    @Test
    void inFlightWriteIsSkippedByReclaimUntilItsTransactionSettles() throws Exception {
        ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin("305");
        mapper.writeValue(writer.stream(), suspended("305", List.of(UserMessageEntity.from("在途"))));
        // 未发布前，任何读取方都看不到这份正文。
        assertThrows(IllegalStateException.class,
                () -> checkpointStore.read("305", writer.fileId(), Execution.class));

        writer.publish();
        assertTrue(checkpointStore.isInFlight("305", writer.fileId()));
        assertEquals(Set.of(writer.fileId()), checkpointStore.inFlightFileIds("305"));
        assertFalse(checkpointStore.delete("305", writer.fileId()), "在途写入不能回收");
        assertNotNull(checkpointStore.read("305", writer.fileId(), Execution.class));

        writer.complete();
        assertFalse(checkpointStore.isInFlight("305", writer.fileId()));
        assertTrue(checkpointStore.inFlightFileIds("305").isEmpty());
        assertTrue(checkpointStore.delete("305", writer.fileId()));
        assertThrows(IllegalStateException.class,
                () -> checkpointStore.read("305", writer.fileId(), Execution.class));
    }

    /** 回滚：本次写入的文件（无论是否已发布）必须被删掉，否则垃圾文件会越堆越多。 */
    @Test
    void rollbackDeletesTheUncommittedFile() throws Exception {
        ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin("305");
        mapper.writeValue(writer.stream(), suspended("305", List.of(UserMessageEntity.from("回滚"))));
        writer.publish();
        String fileId = writer.fileId();

        writer.rollback();

        assertFalse(checkpointStore.isInFlight("305", fileId));
        assertThrows(IllegalStateException.class, () -> checkpointStore.read("305", fileId, Execution.class));
    }

    /** 执行标识与文件标识都直接参与路径，必须挡住路径穿越。 */
    @Test
    void rejectsIdentifiersThatCouldEscapeTheCheckpointDirectory() {
        assertThrows(IllegalArgumentException.class, () -> checkpointStore.begin("../etc"));
        assertThrows(IllegalArgumentException.class, () -> checkpointStore.begin("1/2"));
        assertThrows(IllegalArgumentException.class, () -> checkpointStore.begin(null));
        assertFalse(checkpointStore.delete("305", "../../escape"));
        assertThrows(IllegalArgumentException.class,
                () -> checkpointStore.read("305", "../../escape", Execution.class));
    }

    /** 没有内存副本兜着：库里的引用一改，下一次读就必须读到另一份文件的内容。 */
    @Test
    void everyReadComesFromTheFileTheDatabasePointsAt() {
        seedRow(305L, ExecutionStatusCodes.RUNNING, 1L, null);

        repository.save(suspended("305", List.of(UserMessageEntity.from("第一次"))));
        String first = rows.get(305L).getSnapshotFile();
        repository.save(suspended("305", List.of(UserMessageEntity.from("第二次"))));
        String second = rows.get(305L).getSnapshotFile();

        assertNotEquals(first, second, "每次保存都是新的独立文件");
        assertEquals("第二次", repository.findById("305").orElseThrow().getMessages().getFirst().text());

        // 把权威引用改指向另一份独立发布的文件：读出来必须立刻变。
        String other = publish("305", suspended("305", List.of(UserMessageEntity.from("另一份文件"))));
        rows.get(305L).setSnapshotFile(other);
        assertEquals("另一份文件",
                repository.findById("305").orElseThrow().getMessages().getFirst().text());
    }

    /** 每次返回独立可变副本：改返回值既不影响下一次读，也不改写文件。 */
    @Test
    void everyReadReturnsAnIndependentMutableCopy() {
        seedRow(305L, ExecutionStatusCodes.RUNNING, 1L, null);
        repository.save(suspended("305", List.of(UserMessageEntity.from("原始"))));

        Execution first = repository.findById("305").orElseThrow();
        assertDoesNotThrow(() -> first.getMessages().add(UserMessageEntity.from("追加")));
        assertEquals(2, first.getMessages().size());

        assertEquals(1, repository.findById("305").orElseThrow().getMessages().size(), "文件不能被原地改写");
        assertEquals("原始", repository.findById("305").orElseThrow().getMessages().getFirst().text());
    }

    private static Execution suspended(String executionId, List<Message> history) {
        AgentRequest request = AgentRequest.builder().executionId(executionId).messages(new ArrayList<>(history))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "405")).build()).build();
        return Execution.builder().id(executionId).agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).messages(new ArrayList<>(history)).build();
    }

    private String publish(String executionId, Execution execution) {
        ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin(executionId);
        try {
            mapper.writeValue(writer.stream(), execution);
            writer.publish();
            return writer.fileId();
        } catch (IOException failure) {
            throw new UncheckedIOException("写入测试检查点失败", failure);
        } finally {
            writer.complete();
        }
    }

    private void seedRow(long id, int status, long version, String snapshotFile) {
        rows.put(id, row(id, status, version, snapshotFile));
    }

    private static ExecutionPO row(long id, int status, long version, String snapshotFile) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(405L);
        row.setStatus(status);
        row.setVersion(version);
        row.setSnapshotFile(snapshotFile);
        return row;
    }
}

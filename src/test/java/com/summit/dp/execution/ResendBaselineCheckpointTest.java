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
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
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
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 历史重发的检查点守卫：多轮执行各自保留自己的正文文件。
 *
 * <p>重发的语义是「编辑当时那条提问再发一次」，基线必须取目标轮次自己的检查点，
 * 不能因为后面又跑了新一轮就漂移到最新一轮；也不能让新一轮的保存顺手删掉旧一轮的正文。</p>
 */
class ResendBaselineCheckpointTest {

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
    private final LocalFileCheckpointStore checkpointStore =
            new LocalFileCheckpointStore(dataDir.toString(), mapper);
    /** 假的 execution 表：id → 那一行（含检查点文件标识）。 */
    private final Map<Long, ExecutionPO> rows = new HashMap<>();

    private final LocalExecutionRepository repository = new LocalExecutionRepository(
            new ExecutionCheckpointService(new ExecutionRepositoryImpl(persistence),
                    mock(ApplicationEventPublisher.class)),
            mapper,
            checkpointStore,
            ExecutionRepositoryTestFactory.projectionProvider());

    @BeforeEach
    void prepareFakeTable() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"),
                ExecutionPO.class);
        when(persistence.update(any(ExecutionPO.class), any())).thenAnswer(invocation -> {
            ExecutionPO row = invocation.getArgument(0);
            rows.put(row.getId(), row);
            return 1;
        });
        when(persistence.insert(any(ExecutionPO.class))).thenAnswer(invocation -> {
            ExecutionPO row = invocation.getArgument(0);
            rows.put(row.getId(), row);
            return 1;
        });
        when(persistence.selectById(anyLong())).thenAnswer(invocation ->
                rows.get(invocation.<Long>getArgument(0)));
        when(persistence.selectOne(any())).thenAnswer(invocation -> rows.size() == 1
                ? rows.values().iterator().next() : null);
    }

    /** 每一轮都留着属于自己那一份检查点：重发第 N 轮必须读到第 N 轮自己的基线。 */
    @Test
    void everyTurnKeepsItsOwnCheckpointForResendBaseline() {
        String firstTurnFile = publish("306",
                suspended("306", List.of(UserMessageEntity.from("第一轮提问"))));
        String secondTurnFile = publish("307", suspended("307",
                List.of(UserMessageEntity.from("第一轮提问"), UserMessageEntity.from("第二轮提问"))));
        rows.put(306L, row(306L, firstTurnFile));
        rows.put(307L, row(307L, secondTurnFile));
        assertNotEquals(firstTurnFile, secondTurnFile);

        assertEquals(1, repository.findById("306").orElseThrow().getMessages().size());
        assertEquals(2, repository.findById("307").orElseThrow().getMessages().size());
        assertEquals("第一轮提问", repository.findById("306").orElseThrow().getMessages().getFirst().text());
        assertEquals("第二轮提问", repository.findById("307").orElseThrow().getMessages().getLast().text());
    }

    /** 后续轮次继续保存不会扰动早先轮次的基线：旧文件只在「它自己那一行被替换」后才回收。 */
    @Test
    void savingALaterTurnDoesNotDisturbAnEarlierTurnsBaseline() throws Exception {
        String firstTurnFile = publish("306", suspended("306", List.of(UserMessageEntity.from("第一轮提问"))));
        rows.put(306L, row(306L, firstTurnFile));
        List<Message> firstBaselineBefore = repository.findById("306").orElseThrow().getMessages();
        Path firstTurnPath = dataDir.resolve("checkpoints").resolve("306")
                .resolve(firstTurnFile + ".json");
        byte[] bytesBefore = java.nio.file.Files.readAllBytes(firstTurnPath);

        // 第二轮（另一个 executionId）连续保存两次，各自产生新文件。
        publish("307", suspended("307", List.of(UserMessageEntity.from("第二轮提问"))));
        publish("307", suspended("307", List.of(UserMessageEntity.from("第二轮提问（改写）"))));

        List<Message> firstBaselineAfter = repository.findById("306").orElseThrow().getMessages();
        assertEquals(firstBaselineBefore.size(), firstBaselineAfter.size());
        assertEquals("第一轮提问", firstBaselineAfter.getFirst().text());
        // 第一轮的正文文件字节级未变：重发基线不会被后续轮次改写。
        assertArrayEquals(bytesBefore, java.nio.file.Files.readAllBytes(firstTurnPath),
                "早先轮次的正文文件不能被后续轮次改写");
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

    private static ExecutionPO row(long id, String snapshotFile) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(405L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        row.setVersion(1L);
        row.setSnapshotFile(snapshotFile);
        return row;
    }
}

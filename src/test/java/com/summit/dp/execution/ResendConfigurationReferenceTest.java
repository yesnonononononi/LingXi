package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ResendTargetResolver;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * 重发基线只认目标轮次自己的检查点文件。
 *
 * <p>本类原先验证「旧格式快照（快照树里内联 modelConfig）也能被兼容读取」。方案三取消了
 * 旧 H2 正文与旧格式快照的读取兼容，那条兼容分支连同它的守卫一起下线；现在这里守的是新契约：
 * 正文按库内文件标识流式读取，格式不对或文件缺失都明确失败，绝不静默改读旧版本。</p>
 */
class ResendConfigurationReferenceTest {

    private final ObjectMapper mapper = new JsonConfig().objectMapper();

    @Test
    void resendBaselineComesFromTheTargetTurnsOwnCheckpointFile() throws Exception {
        List<Message> history = List.of(SystemMessageEntity.builder().text("压缩后的历史").build(),
                UserMessageEntity.from("目标提问"));
        Execution execution = Execution.builder().id("100").executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder().messages(history).build())
                .messages(history).build();

        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
        ExecutionMapper rows = rowPointingAt(publish(store, execution));

        ResendTargetResolver.ResendTarget target = resolverOver(rows, dataDir).resolve(
                new ChatCommand("修改提问", 10L, null, null, 30L, null, false, List.of(), List.of()));

        assertEquals(1, target.baseline().size());
        assertEquals("压缩后的历史", target.baseline().getFirst().text());
    }

    @Test
    void unreadableCheckpointFailsLoudlyInsteadOfFallingBackToAnOlderVersion() throws Exception {
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        // 旧格式（快照树里内联 modelConfig）文件：新读取路径不再兼容，必须明确失败而不是静默降级。
        Path directory = Files.createDirectories(dataDir.resolve("checkpoints").resolve("100"));
        String legacyFileId = "0123456789abcdef0123456789abcdef";
        Files.writeString(directory.resolve(legacyFileId + ".json"),
                "{\"id\":\"100\",\"agentRequest\":{\"modelConfig\":{\"apiKey\":\"retired-key-canary\"}},"
                        + "\"messages\":[]}");

        LocalExecutionRepository runtime = runtimeOver(rowPointingAt(legacyFileId), dataDir);

        IllegalStateException failure = assertThrows(IllegalStateException.class, () -> runtime.findById("100"));
        assertTrue(failure.getMessage().contains("无法解析"), failure.getMessage());
    }

    @Test
    void missingCheckpointFileIsAnExplicitFailure() throws Exception {
        LocalExecutionRepository runtime = runtimeOver(rowPointingAt("fedcba9876543210fedcba9876543210"),
                ExecutionRepositoryTestFactory.tempDataDir());

        assertThrows(IllegalStateException.class, () -> runtime.findById("100"));
    }

    /** 只回答「第 100 行指向哪个文件」的行存储；重发路径不关心其它列。 */
    private static ExecutionMapper rowPointingAt(String fileId) {
        ExecutionPO row = new ExecutionPO();
        row.setId(100L);
        row.setSessionId(10L);
        row.setVersion(1L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        row.setSnapshotFile(fileId);
        ExecutionMapper rows = mock(ExecutionMapper.class);
        when(rows.selectById(100L)).thenReturn(row);
        when(rows.selectOne(any())).thenReturn(row);
        return rows;
    }

    /** 正文一律经运行期仓储按库内引用读文件（不再有「整段 JSON 字符串」这一层）。 */
    private LocalExecutionRepository runtimeOver(ExecutionMapper rows, Path dataDir) {
        return ExecutionRepositoryTestFactory.create(rows, mapper, dataDir);
    }

    private ResendTargetResolver resolverOver(ExecutionMapper rows, Path dataDir) {
        SessionMessageQueryService messages = mock(SessionMessageQueryService.class);
        ChatTurnService turns = mock(ChatTurnService.class);
        when(messages.findByMessageId(30L)).thenReturn(Result.success(SessionMessageVO.builder()
                .id(30L).turnId(20L).sessionId(10L).type("USER").build()));
        when(turns.findByIds(List.of(20L))).thenReturn(Map.of(20L,
                ChatTurn.builder().id(20L).sessionId(10L).executionId(100L).build()));
        return new ResendTargetResolver(messages, turns, runtimeOver(rows, dataDir));
    }

    /** 走存储端口发布一份真实检查点文件，返回库内该存的权威文件标识。 */
    private String publish(LocalFileCheckpointStore store, Execution execution) throws Exception {
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
}

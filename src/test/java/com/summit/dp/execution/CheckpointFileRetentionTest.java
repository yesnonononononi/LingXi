package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「提交后只回收正确的旧文件」守卫：同一执行反复保存，目录里只能留下库内引用的那一份。
 *
 * <p><b>为什么单独守</b>：检查点目录是长期累积的垃圾场。若提交后不删旧文件，每轮保存都会
 * 留下一个完整正文副本，几十轮之后目录体积与恢复扫描量一起涨 —— 这正是方案里
 * 「文件数随旧版本回收保持稳定」的验收点。只断言「读到了新内容」看不出这个问题，
 * 必须直接数文件。</p>
 */
class CheckpointFileRetentionTest {

    private static final String EXECUTION_ID = "305";
    private static final long NUMERIC_ID = 305L;
    private static final int ROUNDS = 8;

    @Test
    @Timeout(120)
    void repeatedSavesKeepExactlyOneCommittedFile() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("checkpoint-retention");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        try {
            ExecutionMapper executions = SqliteTestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(executions, mapper, store);

            ExecutionPO row = new ExecutionPO();
            row.setId(NUMERIC_ID);
            row.setSessionId(10L);
            row.setVersion(1L);
            row.setStatus(ExecutionStatusCodes.SUSPENDED);
            executions.insert(row);

            for (int round = 0; round < ROUNDS; round++) {
                repository.save(execution(round));
            }

            List<String> files = checkpointFiles(dataDir);
            assertEquals(1, files.size(), () -> "同一执行反复保存后目录里应只剩一份正文，实际: " + files);
            String committed = executions.selectById(NUMERIC_ID).getSnapshotFile();
            assertEquals(committed + ".json", files.getFirst(), "留下的必须是库内引用的那一份");
            assertTrue(repository.findById(EXECUTION_ID).orElseThrow().getMessages().getFirst().text()
                    .startsWith("第8轮"), "读到的必须是最后一轮的内容");
        } finally {
            database.shutdown();
        }
    }

    private static Execution execution(int round) {
        List<com.summit.core.conversation.message.Message> history = new java.util.ArrayList<>();
        history.add(com.summit.core.conversation.message.UserMessageEntity.from("第" + (round + 1) + "轮"));
        return com.summit.core.agent.Execution.builder().id(EXECUTION_ID).agentId("chatAgent")
                .agentRequest(com.summit.core.agent.AgentRequest.builder()
                        .executionId(EXECUTION_ID).messages(history)
                        .runtimeParameters(com.summit.core.agent.AgentRuntimeParameters.builder()
                                .attributes(java.util.Map.of(ExecutionAttributes.SESSION_ID, "10")).build())
                        .build())
                .executionState(com.summit.core.agent.ExecutionState.SUSPENDED).messages(history).build();
    }

    private static List<String> checkpointFiles(Path dataDir) throws Exception {
        Path directory = dataDir.resolve("checkpoints").resolve(EXECUTION_ID);
        if (!Files.isDirectory(directory)) {
            return List.of();
        }
        try (Stream<Path> paths = Files.list(directory)) {
            return paths.map(path -> path.getFileName().toString()).sorted().toList();
        }
    }
}

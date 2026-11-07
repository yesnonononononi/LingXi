package com.summit.dp.execution.qa;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * §4.5「检查点与 session_context 重复序列化」的度量探针：<b>先量，再决定动不动</b>。
 *
 * <p>量的是三件事：一次 {@code save} 写出的 JSON 字节与耗时、一次
 * {@code modelContextService.replace} 写入量与耗时、以及<b>同一份消息集合在一次工具调用里被完整
 * 序列化几次</b>。产物是一份打印出来的报告（中位数 / p95），并断言几条结构性事实，防止探针
 * 本身悄悄失效（例如写 0 字节也算「通过」）。</p>
 *
 * <p><b>为什么用真库真文件</b>：结论要指导是否改实现，用内存库或桩对象量出来的字节数与耗时
 * 不能代表生产（检查点是 fsync 落盘、session_context 是 CLOB 列），那种数字没有决策价值。</p>
 *
 * <p>复现：{@code mvn -o test -Dtest=ContextSerializationDuplicationProbeTest}</p>
 */
class ContextSerializationDuplicationProbeTest {

    /** 一轮对话里的工具调用次数：按用户说的「单轮 30 次工具调用」量级构造。 */
    private static final int TOOL_CALLS = 30;
    /** 预热次数：让 JIT 与文件缓存先行，避免把冷启动噪声当成稳态。 */
    private static final int WARMUP_ROUNDS = 3;
    /** 采样次数：中位数与 p95 都靠它；本机 fsync 较慢，12 次已足以压住单次抖动。 */
    private static final int SAMPLE_ROUNDS = 12;
    private static final long EXECUTION_ID = 305L;
    private static final long SESSION_ID = 405L;

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("度量一次工具调用里检查点与模型上下文的写入量、耗时与重复序列化次数")
    void measureCheckpointAndContextSerialization() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("context-serialization-probe");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        try {
            SqlSessionTemplate sql = H2TestDatabase.sqlSession(
                    database.sessionFactory(ExecutionMapper.class, SessionContextMapper.class));
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            SessionContextMapper contexts = sql.getMapper(SessionContextMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(executions, mapper, store);
            ModelContextService modelContextService = new ModelContextService(mapper,
                    new SessionContextRepositoryImpl(contexts));

            ExecutionPO row = new ExecutionPO();
            row.setId(EXECUTION_ID);
            row.setSessionId(SESSION_ID);
            row.setVersion(1L);
            row.setStatus(ExecutionStatusCodes.RUNNING);
            executions.insert(row);

            Execution execution = execution();
            List<Message> messages = execution.getMessages();

            // ---- 量 ①：一次 save（检查点正文：流式 JSON + fsync + 原子发布 + 库内版本条件提交）
            List<Long> saveNanos = new ArrayList<>();
            long checkpointBytes = 0L;
            for (int round = 0; round < WARMUP_ROUNDS + SAMPLE_ROUNDS; round++) {
                long startedAt = System.nanoTime();
                repository.save(execution);
                long elapsed = System.nanoTime() - startedAt;
                checkpointBytes = checkpointSize(dataDir, executions);
                if (round >= WARMUP_ROUNDS) {
                    saveNanos.add(elapsed);
                }
            }
            assertTrue(checkpointBytes > 0L, "检查点必须真的写出正文，量到 0 字节说明探针失效");

            // ---- 量 ②：一次 modelContextService.replace（整段上下文序列化 + CLOB 覆盖写）
            List<Long> replaceNanos = new ArrayList<>();
            long contextBytes = 0L;
            for (int round = 0; round < WARMUP_ROUNDS + SAMPLE_ROUNDS; round++) {
                long startedAt = System.nanoTime();
                modelContextService.replace(SESSION_ID, messages);
                long elapsed = System.nanoTime() - startedAt;
                contextBytes = contextContentBytes(contexts);
                if (round >= WARMUP_ROUNDS) {
                    replaceNanos.add(elapsed);
                }
            }
            assertTrue(contextBytes > 0L, "session_context 必须真的写入正文，量到 0 字节说明探针失效");

            // ---- 量 ③：纯序列化成本（可共享的那部分 CPU），与上面两次写入里的编码步骤同源
            List<Long> checkpointEncodeNanos = new ArrayList<>();
            List<Long> contextEncodeNanos = new ArrayList<>();
            long encodedCheckpointBytes = 0L;
            long encodedContextBytes = 0L;
            for (int round = 0; round < WARMUP_ROUNDS + SAMPLE_ROUNDS; round++) {
                long startedAt = System.nanoTime();
                byte[] checkpointJson = mapper.writeValueAsBytes(execution);
                long checkpointElapsed = System.nanoTime() - startedAt;
                startedAt = System.nanoTime();
                byte[] contextJson = mapper.writeValueAsBytes(messages);
                long contextElapsed = System.nanoTime() - startedAt;
                encodedCheckpointBytes = checkpointJson.length;
                encodedContextBytes = contextJson.length;
                if (round >= WARMUP_ROUNDS) {
                    checkpointEncodeNanos.add(checkpointElapsed);
                    contextEncodeNanos.add(contextElapsed);
                }
            }

            // ---- 量 ③ 的第二面：同一份消息集合在一次工具调用里被完整序列化几次
            // 检查点正文里嵌了一份 messages，session_context 里又存了一份 —— 结构化比对确认「同一份」，
            // 而不是「两份凑巧字数相近的 JSON」。
            JsonNode checkpointMessages = mapper.readTree(checkpointFile(dataDir, executions).toFile()).get("messages");
            JsonNode contextMessages = mapper.readTree(contexts.selectById(SESSION_ID).getContent());
            assertNotNull(checkpointMessages, "检查点正文里必须有 messages 字段");
            assertEquals(messages.size(), checkpointMessages.size(), "检查点里的消息条数必须与内存一致");
            assertEquals(messages.size(), contextMessages.size(), "session_context 里的消息条数必须与内存一致");
            boolean identical = checkpointMessages.equals(contextMessages);
            String firstCheckpoint = checkpointMessages.get(0).toString();
            String firstContext = contextMessages.get(0).toString();
            assertEquals(firstCheckpoint, firstContext, "两份序列化结果的首条消息必须逐字一致");

            long saveMedian = median(saveNanos);
            long saveP95 = percentile(saveNanos, 95);
            long replaceMedian = median(replaceNanos);
            long replaceP95 = percentile(replaceNanos, 95);
            long checkpointEncodeMedian = median(checkpointEncodeNanos);
            long checkpointEncodeP95 = percentile(checkpointEncodeNanos, 95);
            long contextEncodeMedian = median(contextEncodeNanos);
            long contextEncodeP95 = percentile(contextEncodeNanos, 95);
            long windowMedian = windowMedian(saveNanos, replaceNanos);

            System.out.println("""

                    ================= §4.5 重复序列化度量报告 =================
                    规模：单轮 %d 次工具调用，消息 %d 条（%d 条 AI + %d 条工具结果 + 1 条用户）
                    采样：预热 %d 次 + 采样 %d 次（H2 文件库 + 真 LocalExecutionRepository/真实文件检查点）
                    ---------------------------------------------------------
                    [①] 一次 save（检查点正文）
                        写盘字节: %,d B（约 %.1f KiB）
                        耗时中位数: %.3f ms，p95: %.3f ms
                    [②] 一次 modelContextService.replace
                        写库字节: %,d B（约 %.1f KiB）
                        耗时中位数: %.3f ms，p95: %.3f ms
                    [③] 纯序列化（可共享的编码成本）
                        检查点外壳编码: %,d B，中位数 %.3f ms，p95 %.3f ms
                        模型上下文编码: %,d B，中位数 %.3f ms，p95 %.3f ms
                        一次工具调用内完整序列化次数: 2（检查点 1 + session_context 1）
                        两份 messages 是否逐字复合: %s
                    ---------------------------------------------------------
                    一次工具调用窗口（save + replace）中位数: %.3f ms
                    重复编码占窗口比例: %.2f%%（以模型上下文那份编码计）
                    重复写盘占窗口字节: 模型上下文/检查点 = %.1f%%
                    =========================================================

                    """.formatted(
                    TOOL_CALLS, messages.size(), TOOL_CALLS, TOOL_CALLS, WARMUP_ROUNDS, SAMPLE_ROUNDS,
                    checkpointBytes, checkpointBytes / 1024.0,
                    nanosToMillis(saveMedian), nanosToMillis(saveP95),
                    contextBytes, contextBytes / 1024.0,
                    nanosToMillis(replaceMedian), nanosToMillis(replaceP95),
                    encodedCheckpointBytes, nanosToMillis(checkpointEncodeMedian), nanosToMillis(checkpointEncodeP95),
                    encodedContextBytes, nanosToMillis(contextEncodeMedian), nanosToMillis(contextEncodeP95),
                    identical ? "是（同一份消息集合被写了两次）" : "否（两份内容不同，需人工核对）",
                    nanosToMillis(windowMedian),
                    100.0 * contextEncodeMedian / Math.max(1L, windowMedian),
                    100.0 * contextBytes / Math.max(1L, checkpointBytes)));
        } finally {
            database.shutdown();
        }
    }

    /** 30 次工具调用的典型一轮：1 条用户提问 + 每轮「AI 带一次工具调用」+「工具结果」。 */
    private static Execution execution() {
        List<Message> history = new ArrayList<>();
        history.add(UserMessageEntity.from("请把这份三千行的日志按错误类型归类并给出结论"));
        for (int index = 0; index < TOOL_CALLS; index++) {
            history.add(AiMessageEntity.builder().text("继续读取第 " + (index + 1) + " 段日志")
                    .toolCalls(List.of(ToolCallRequest.builder().id("call-" + index).name("read_file")
                            .requestIndex(index).arguments("{\"path\":\"logs/app-" + index + ".log\"}").build()))
                    .build());
            history.add(ToolMessageEntity.builder().id("call-" + index).name("read_file")
                    .toolOutput(toolOutput(index)).build());
        }
        List<Message> snapshot = Collections.unmodifiableList(history);
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(new ArrayList<>(snapshot))
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID)))
                                .build())
                        .build())
                .executionState(ExecutionState.RUNNING).messages(new ArrayList<>(snapshot)).build();
    }

    /** 一份接近真实的工具输出：约 400 字符的日志片段，避免用「短字符串」把字节数量小到失真。 */
    private static String toolOutput(int index) {
        StringBuilder output = new StringBuilder();
        output.append("2026-11-07 10:").append(String.format("%02d", index % 60)).append(":00 WARN worker-")
                .append(index).append(" 重试连接失败 attempt=").append(index + 1).append('\n');
        for (int line = 0; line < 4; line++) {
            output.append("    at com.summit.dp.worker.Handler.run(Handler.java:")
                    .append(100 + index).append(") 处理第 ").append(index).append(" 段日志第 ")
                    .append(line).append(" 行\n");
        }
        return output.toString();
    }

    private static long checkpointSize(Path dataDir, ExecutionMapper executions) {
        return checkpointFile(dataDir, executions).toFile().length();
    }

    private static Path checkpointFile(Path dataDir, ExecutionMapper executions) {
        String fileId = executions.selectById(EXECUTION_ID).getSnapshotFile();
        assertNotNull(fileId, "保存后库内必须指向本次发布的检查点文件");
        return dataDir.resolve("checkpoints").resolve(String.valueOf(EXECUTION_ID)).resolve(fileId + ".json");
    }

    private static long contextContentBytes(SessionContextMapper contexts) {
        SessionContextPO current = contexts.selectById(SESSION_ID);
        assertNotNull(current, "replace 之后 session_context 必须有一行");
        // 直接量落库字符串的 UTF-8 字节：建临时文件再取长度会把 fsync 成本混进字节统计里。
        return current.getContent().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    private static long median(List<Long> values) {
        return percentile(values, 50);
    }

    private static long percentile(List<Long> values, int percentile) {
        if (values.isEmpty()) {
            throw new IllegalStateException("没有采样数据");
        }
        List<Long> sorted = new ArrayList<>(values);
        Collections.sort(sorted);
        int index = (int) Math.ceil(percentile / 100.0 * sorted.size()) - 1;
        return sorted.get(Math.clamp(index, 0, sorted.size() - 1));
    }

    /** 一次工具调用窗口 = 一次 save + 一次 replace：各取中位数相加，避免两边样本错位配对。 */
    private static long windowMedian(List<Long> saveNanos, List<Long> replaceNanos) {
        return median(saveNanos) + median(replaceNanos);
    }

    private static double nanosToMillis(long nanos) {
        return nanos / 1_000_000.0;
    }
}

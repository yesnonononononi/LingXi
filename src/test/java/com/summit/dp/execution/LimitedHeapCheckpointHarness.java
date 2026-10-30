package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.ApplicationEventPublisher;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;

/**
 * 512 MiB 受限堆下的真实保存压力夹具（由 {@link LimitedHeapCheckpointOomTest} 在子 JVM 里启动）。
 *
 * <p><b>为什么必须是独立进程</b>：{@code -Xmx} 只能在 JVM 启动时固定，同一进程里没法给某一个
 * 用例单独压小堆；而用户要的是「真实进程会不会 OOM」这个事实，不是估算。</p>
 *
 * <p><b>负载与现场对齐</b>：单执行连续保存 + 三执行并发保存 + 一个会话下多条历史执行各自保存 +
 * 会话上下文写入；正文是含中文的长文本，体积按 UTF-8 实测字节数输出，不按字符数猜。
 * 执行表与会话上下文都用真实 SQLite 文件库，保存走的仍是生产那条
 * {@code LocalExecutionRepository#save}。</p>
 */
public final class LimitedHeapCheckpointHarness {

    /** 正文段数：24 段 × 10 万汉字，序列化后 ≥ 12 MB UTF-8（与用户现场 8 MiB 级执行同量级）。 */
    private static final int MESSAGE_COUNT = 24;
    private static final int CHARS_PER_MESSAGE = 100_000;
    private static final long BYTES_PER_MB = 1024L * 1024L;
    /** 并发保存的执行数：对应用户现场「三个执行并发频繁保存」。 */
    private static final int CONCURRENT_EXECUTIONS = 3;

    private LimitedHeapCheckpointHarness() {
    }

    /**
     * @param args 依次为 数据目录、单执行轮数、并发轮数、历史执行数、会话上下文轮数（全部可省略）
     */
    public static void main(String[] args) throws Exception {
        Path dataDir = Path.of(args.length > 0 ? args[0] : Files.createTempDirectory("lingxi-heap-").toString());
        int singleRounds = args.length > 1 ? Integer.parseInt(args[1]) : 10;
        int concurrentRounds = args.length > 2 ? Integer.parseInt(args[2]) : 5;
        int historyExecutions = args.length > 3 ? Integer.parseInt(args[3]) : 40;
        int contextRounds = args.length > 4 ? Integer.parseInt(args[4]) : 5;

        PeakHeapSampler sampler = new PeakHeapSampler();
        sampler.start();
        SqliteTestDatabase database = null;
        try {
            database = SqliteTestDatabase.create("heap-harness");
            ObjectMapper plainMapper = new JsonConfig().objectMapper();
            // 只有检查点这条路径的 mapper 被 spy：保存路径偷偷拼整段 JSON 字符串才看得见。
            ObjectMapper checkpointMapper = spy(new JsonConfig().objectMapper());

            SqlSessionTemplate sql = SqliteTestDatabase.sqlSession(
                    database.sessionFactory(ExecutionMapper.class, SessionContextMapper.class));
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            LocalFileCheckpointStore checkpointStore =
                    new LocalFileCheckpointStore(dataDir.toString(), checkpointMapper);
            LocalExecutionRepository repository = new LocalExecutionRepository(
                    new ExecutionCheckpointService(new ExecutionRepositoryImpl(executions),
                            mock(ApplicationEventPublisher.class)),
                    checkpointMapper,
                    checkpointStore,
                    ExecutionRepositoryTestFactory.provider(mock(ToolCallReadinessService.class)),
                    ExecutionRepositoryTestFactory.provider(mock(ToolCallService.class)),
                    ExecutionRepositoryTestFactory.provider(mock(SubExecutionLifecycle.class)),
                    ExecutionRepositoryTestFactory.provider(mock(SessionContextUsageProjector.class)),
                    ExecutionRepositoryTestFactory.provider(mock(ChatTurnLifecycleProjector.class)),
                    ExecutionRepositoryTestFactory.provider(mock(RuntimeEventPublisher.class)));

            List<Message> body = body();
            long fixtureBytes = plainMapper.writeValueAsBytes(
                    execution("1", body, ExecutionState.SUSPENDED)).length;
            System.out.println("FIXTURE_BYTES=" + fixtureBytes);
            System.out.println("MAX_HEAP_MB=" + Runtime.getRuntime().maxMemory() / BYTES_PER_MB);

            // ① 单执行连续保存：最贴近「一次执行里每轮都在存」的现场。
            seed(executions, 1L, ExecutionStatusCodes.SUSPENDED);
            Execution single = execution("1", body, ExecutionState.SUSPENDED);
            long saveStart = System.nanoTime();
            for (int round = 0; round < singleRounds; round++) {
                repository.save(single);
            }
            long saveMillis = (System.nanoTime() - saveStart) / 1_000_000L;
            System.out.println("SINGLE_ROUNDS=" + singleRounds);

            // ② 三执行并发保存：用户复现 OOM 时正是多执行频繁保存叠加。
            List<Execution> concurrent = new ArrayList<>();
            for (int index = 0; index < CONCURRENT_EXECUTIONS; index++) {
                String id = Integer.toString(10 + index);
                seed(executions, Long.parseLong(id), ExecutionStatusCodes.SUSPENDED);
                concurrent.add(execution(id, body, ExecutionState.SUSPENDED));
            }
            List<Thread> workers = new ArrayList<>();
            List<Throwable> failures = new CopyOnWriteArrayList<>();
            for (Execution execution : concurrent) {
                Thread worker = new Thread(() -> {
                    try {
                        for (int round = 0; round < concurrentRounds; round++) {
                            repository.save(execution);
                        }
                    } catch (Throwable failure) {
                        failures.add(failure);
                    }
                }, "concurrent-save-" + execution.getId());
                workers.add(worker);
                worker.start();
            }
            for (Thread worker : workers) {
                worker.join();
            }
            if (!failures.isEmpty()) {
                throw new IllegalStateException("并发保存失败: " + failures.getFirst());
            }
            System.out.println("CONCURRENT_EXECUTIONS=" + CONCURRENT_EXECUTIONS);
            System.out.println("CONCURRENT_ROUNDS=" + concurrentRounds);

            // ③ 一个会话下多条历史执行各自保留检查点：旧实现会为每条执行缓存整段 JSON。
            for (int index = 0; index < historyExecutions; index++) {
                long id = 1000L + index;
                seed(executions, id, ExecutionStatusCodes.COMPLETED);
                repository.save(execution(Long.toString(id), body, ExecutionState.COMPLETED));
            }
            System.out.println("HISTORY_EXECUTIONS=" + historyExecutions);

            // ④ 会话上下文写入：本轮仍有整段 JSON 字符串，必须计入同一个堆压力。
            ModelContextService contextService = new ModelContextService(plainMapper,
                    new SessionContextRepositoryImpl(sql.getMapper(SessionContextMapper.class)));
            for (int round = 0; round < contextRounds; round++) {
                contextService.replace(900L + round, body);
            }
            System.out.println("CONTEXT_ROUNDS=" + contextRounds);

            // 恢复计时：从文件流式读回，验证「没有正文缓存也能读」。
            long restoreStart = System.nanoTime();
            Execution restored = repository.findById("1").orElseThrow(
                    () -> new IllegalStateException("恢复不到刚保存的检查点"));
            long restoreMillis = (System.nanoTime() - restoreStart) / 1_000_000L;
            if (restored.getMessages() == null || restored.getMessages().size() != MESSAGE_COUNT) {
                throw new IllegalStateException("恢复出来的正文不完整: messages="
                        + (restored.getMessages() == null ? "null" : restored.getMessages().size()));
            }
            System.out.println("SAVE_MS=" + saveMillis);
            System.out.println("RESTORE_MS=" + restoreMillis);

            long wholeDocumentConversions = org.mockito.Mockito.mockingDetails(checkpointMapper)
                    .getInvocations().stream()
                    .filter(invocation -> "writeValueAsString".equals(invocation.getMethod().getName())
                            || "writeValueAsBytes".equals(invocation.getMethod().getName()))
                    .count();
            System.out.println("CHECKPOINT_WHOLE_DOCUMENT_STRINGS=" + wholeDocumentConversions);
            System.out.println("CHECKPOINT_STREAM_WRITES="
                    + org.mockito.Mockito.mockingDetails(checkpointMapper).getInvocations().stream()
                    .filter(invocation -> "writeValue".equals(invocation.getMethod().getName()))
                    .count());

            sampler.stop();
            long gcMillis = ManagementFactory.getGarbageCollectorMXBeans().stream()
                    .mapToLong(bean -> bean.getCollectionTime())
                    .sum();
            System.out.println("GC_MS=" + gcMillis);
            System.out.println("PEAK_HEAP_MB=" + sampler.peakBytes() / BYTES_PER_MB);
            System.out.println("RESULT=OK");
        } catch (OutOfMemoryError oom) {
            // 打印本身也可能再 OOM：尽力而为，退出码才是权威信号。
            System.out.println("OOM=" + oom.getClass().getSimpleName());
            System.out.println("PEAK_HEAP_MB=" + sampler.peakBytes() / BYTES_PER_MB);
            System.out.flush();
            System.exit(3);
        } catch (Throwable failure) {
            System.out.println("RESULT=FAILED");
            failure.printStackTrace(System.out);
            sampler.stop();
            System.out.println("PEAK_HEAP_MB=" + sampler.peakBytes() / BYTES_PER_MB);
            System.out.flush();
            System.exit(4);
        } finally {
            if (database != null) {
                database.shutdown();
            }
            deleteQuietly(dataDir);
        }
    }

    /** 建一条「已有检查点元数据」的执行行，模拟执行已在库里存在。 */
    private static void seed(ExecutionMapper executions, long id, int status) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(900L);
        row.setStatus(status);
        row.setVersion(1L);
        executions.insert(row);
    }

    /** 含中文的长正文：UTF-8 下每汉字 3 字节，JSON 转义不放大。 */
    private static List<Message> body() {
        List<Message> messages = new ArrayList<>(MESSAGE_COUNT);
        for (int index = 0; index < MESSAGE_COUNT; index++) {
            messages.add(UserMessageEntity.from(paragraph(index, CHARS_PER_MESSAGE)));
        }
        return messages;
    }

    private static String paragraph(int index, int chars) {
        StringBuilder text = new StringBuilder(chars + 64);
        text.append("第").append(index + 1).append("段：执行检查点正文与模型上下文，含中文与标点，用来贴近真实会话。");
        int marker = 0;
        while (text.length() < chars) {
            text.append("模型输出片段").append(marker++).append("，检查点保存与恢复必须保持内容一致；");
        }
        return text.toString();
    }

    private static Execution execution(String executionId, List<Message> body, ExecutionState state) {
        AgentRequest request = AgentRequest.builder().executionId(executionId)
                .messages(new ArrayList<>(body))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "900")).build()).build();
        return Execution.builder().id(executionId).agentId("chatAgent").agentRequest(request)
                .executionState(state).messages(new ArrayList<>(body)).build();
    }

    private static void deleteQuietly(Path directory) {
        try (Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception ignored) {
                    // 系统临时目录由系统兜底清理，不掩盖用例结论。
                }
            });
        } catch (Exception ignored) {
            // 同上。
        }
    }

    /** 后台采样峰值堆：{@code MemoryMXBean#getHeapMemoryUsage()} 取已用堆的最大值。 */
    private static final class PeakHeapSampler {

        private final java.lang.management.MemoryMXBean memoryBean = ManagementFactory.getMemoryMXBean();
        private volatile boolean running = true;
        private volatile long peakBytes;
        private Thread thread;

        private void start() {
            thread = new Thread(() -> {
                while (running) {
                    long used = memoryBean.getHeapMemoryUsage().getUsed();
                    if (used > peakBytes) {
                        peakBytes = used;
                    }
                    try {
                        Thread.sleep(10L);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }, "peak-heap-sampler");
            thread.setDaemon(true);
            thread.start();
        }

        private void stop() {
            running = false;
            long used = memoryBean.getHeapMemoryUsage().getUsed();
            if (used > peakBytes) {
                peakBytes = used;
            }
            if (thread != null) {
                try {
                    thread.join(1_000L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        private long peakBytes() {
            return peakBytes;
        }
    }
}

package com.summit.dp.execution;

import com.fasterxml.jackson.core.JsonProcessingException;
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
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.ApplicationEventPublisher;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

import static org.mockito.Mockito.mock;
import com.summit.core.agent.ContextSpec;

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

    /** 堆读数入口（{@code usedBytesAfterFullGc} 与采样线程共用）。 */
    private static final java.lang.management.MemoryMXBean MEMORY = ManagementFactory.getMemoryMXBean();
    /** 并发保存的执行数：对应用户现场「三个执行并发频繁保存」。 */
    private static final int CONCURRENT_EXECUTIONS = 3;
    /** 同一大上下文连续更新的默认轮数（复核 R5 要求补的压力场景）。 */
    private static final int SAME_CONTEXT_ROUNDS_DEFAULT = 5;
    /** 这条上下文一直用同一个会话标识，模拟长会话里反复整体替换上下文。 */
    private static final long SAME_CONTEXT_SESSION_ID = 777L;

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
        int sameContextRounds = args.length > 5 ? Integer.parseInt(args[5]) : SAME_CONTEXT_ROUNDS_DEFAULT;

        PeakHeapSampler sampler = new PeakHeapSampler();
        // 起始活集合（满 GC 之后）：给峰值一个参照点，也能一眼分辨「起始堆就已经很高」的情况。
        long baselineBytes = usedBytesAfterFullGc();
        sampler.start();
        H2TestDatabase database = null;
        try {
            database = H2TestDatabase.create("heap-harness");
            ObjectMapper plainMapper = new JsonConfig().objectMapper();
            // 检查点这条路径用「只数次数、不保留实参」的计数 mapper。
            // 之前用 Mockito spy：它把每次调用的**实参**留在调用历史里，整段 JSON 字符串因此被钉在堆上，
            // 于是「字符串变异必然 OOM」这个结论其实是被计量方式污染的（复核 R5）。
            CountingObjectMapper checkpointMapper = new CountingObjectMapper(new JsonConfig().objectMapper());

            SqlSessionTemplate sql = H2TestDatabase.sqlSession(
                    database.sessionFactory(ExecutionMapper.class, SessionContextMapper.class));
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            LocalFileCheckpointStore checkpointStore =
                    new LocalFileCheckpointStore(dataDir.toString(), checkpointMapper);
            LocalExecutionRepository repository = new LocalExecutionRepository(
                    new ExecutionCheckpointService(new ExecutionRepositoryImpl(executions),
                            mock(ApplicationEventPublisher.class)),
                    checkpointMapper,
                    checkpointStore,
                    ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());

            List<Message> body = body();
            long fixtureBytes = plainMapper.writeValueAsBytes(
                    execution("1", body, ExecutionState.SUSPENDED)).length;
            System.out.println("FIXTURE_BYTES=" + fixtureBytes);
            System.out.println("MAX_HEAP_MB=" + Runtime.getRuntime().maxMemory() / BYTES_PER_MB);
            System.out.println("HEAP_BASELINE_MB=" + baselineBytes / BYTES_PER_MB);

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

            // ⑤ 同一个大上下文连续更新 5 轮：长会话里上下文是被反复整体替换的，
            //    「5 个不同会话各写一次」与「同一个会话连写 5 次」的堆行为并不一样（后者会反复
            //    覆盖同一行、叠加旧正文与旧字符串），复核 R5 指出上一版漏了这条。
            for (int round = 0; round < sameContextRounds; round++) {
                contextService.replace(SAME_CONTEXT_SESSION_ID, body);
            }
            System.out.println("SAME_CONTEXT_ROUNDS=" + sameContextRounds);

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

            System.out.println("CHECKPOINT_WHOLE_DOCUMENT_STRINGS=" + checkpointMapper.wholeDocumentConversions());
            System.out.println("CHECKPOINT_STREAM_WRITES=" + checkpointMapper.streamWrites());

            // 「活集合」口径：满 GC 之后仍被引用占着的堆 —— 与 GC 时序无关，跨机器/跨负载可比。
            long retainedBytes = usedBytesAfterFullGc();
            // 保活：这次使用让 body/single/concurrent/restored 在测量点仍然可达，否则 JIT 可能
            // 把它们提前判成不可达，测出来就成了「什么都留不住」的假象。
            System.out.println("LIVE_REFS=" + (body.size() + single.getMessages().size()
                    + concurrent.size() + restored.getMessages().size()));
            System.out.println("HEAP_RETAINED_MB=" + retainedBytes / BYTES_PER_MB);
            System.out.println("PEAK_HEAP_SAMPLES=" + sampler.samples());

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

    /**
     * 满 GC 之后再看一次已用堆：这才是「真正被钉在堆上」的活集合（live set），
     * 与 GC 在什么时刻跑、跑得多快无关，因此跨机器/跨负载可比。
     *
     * <p><b>为什么需要它</b>：{@code PEAK_HEAP_MB} 是「10ms 采样看到的最大已用堆」，
     * 它包含<b>还没来得及回收的垃圾</b>——机器一忙、GC 线程被饿住，这个数就从 150 MiB 涨到 370 MiB，
     * 而代码一行没变（详见 {@link LimitedHeapCheckpointOomTest} 的分布表）。
     * 真正想守的是「正文有没有被囤在堆里」，那属于<b>活对象</b>，只有满 GC 之后才看得清。</p>
     */
    private static long usedBytesAfterFullGc() throws InterruptedException {
        for (int attempt = 0; attempt < 2; attempt++) {
            System.gc();
            Thread.sleep(150L);
        }
        return MEMORY.getHeapMemoryUsage().getUsed();
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
                .contextSpec(ContextSpec.builder().context(new ArrayList<>(body)).build())
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

    /**
     * 只数次数、<b>不保留任何实参</b>的计数 mapper。
     *
     * <p>为什么不用 Mockito spy：spy 的调用历史会把每次调用的实参（这里是整段 JSON 字符串）
     * 一起留在堆里，计量本身就把内存抬了上去 —— 复核 R5 实测「保留历史 → OOM，清历史 → 同负载跑完」。
     * 交互断言（保存路径不许整段中转）只需要次数，所以用两个原子计数就够了，堆上不留任何引用。</p>
     */
    private static final class CountingObjectMapper extends ObjectMapper {

        private final ObjectMapper delegate;
        private final AtomicLong wholeDocument = new AtomicLong();
        private final AtomicLong streamWrites = new AtomicLong();

        private CountingObjectMapper(ObjectMapper delegate) {
            this.delegate = delegate;
        }

        @Override
        public void writeValue(OutputStream out, Object value) throws IOException {
            streamWrites.incrementAndGet();
            delegate.writeValue(out, value);
        }

        @Override
        public String writeValueAsString(Object value) throws JsonProcessingException {
            wholeDocument.incrementAndGet();
            return delegate.writeValueAsString(value);
        }

        @Override
        public byte[] writeValueAsBytes(Object value) throws JsonProcessingException {
            wholeDocument.incrementAndGet();
            return delegate.writeValueAsBytes(value);
        }

        @Override
        public <T> T readValue(InputStream src, Class<T> valueType) throws IOException {
            return delegate.readValue(src, valueType);
        }

        private long wholeDocumentConversions() {
            return wholeDocument.get();
        }

        private long streamWrites() {
            return streamWrites.get();
        }
    }

    /** 后台采样峰值堆：{@code MemoryMXBean#getHeapMemoryUsage()} 取已用堆的最大值。 */
    private static final class PeakHeapSampler {

        private final java.lang.management.MemoryMXBean memoryBean = MEMORY;
        private volatile boolean running = true;
        private volatile long peakBytes;
        /** 采样次数：负载重时采样点会变少，峰值含义随之变化，所以要跟峰值一起打印出来。 */
        private final AtomicLong sampleCount = new AtomicLong();
        private Thread thread;

        private void start() {
            thread = new Thread(() -> {
                while (running) {
                    long used = memoryBean.getHeapMemoryUsage().getUsed();
                    if (used > peakBytes) {
                        peakBytes = used;
                    }
                    sampleCount.incrementAndGet();
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

        /** 采样点个数（10ms 一个点）：红的时候先看它是「真囤内存」还是「采不到」。 */
        private long samples() {
            return sampleCount.get();
        }
    }
}

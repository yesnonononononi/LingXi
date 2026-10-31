import java.io.BufferedWriter;
import java.io.IOException;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

/**
 * OOM 事故回归的重放主体（T05 单元 E，§附录E.1 的 {@code h2-new} 与 {@code positive-control} 两组）。
 *
 * <p><b>重放什么</b>：用事故现场导出的真实正文（{@code replay-fixtures} 里的 execution / context
 * JSON）在<b>真实 H2 文件库</b>上重复执行「执行检查点保存 + 会话上下文整段替换」，直到轮数用尽或失败。
 * 失败按 {@code none / OOM-heap / GC-overhead / H2-lock / H2-panic / harness-error} 分类。</p>
 *
 * <p><b>两种保存形态（这就是变异点本身）</b>：</p>
 * <ul>
 *   <li>{@code --mode=file}：检查点正文写文件、库里只留文件名（生产形态，{@code execution.snapshot_file}）；</li>
 *   <li>{@code --mode=varchar}：正文整段塞进 {@code execution.snapshot} 的
 *       {@code CHARACTER VARYING(1000000000)} 列（旧 2.3.232 事故形态，§附录E.4 的正对照）。</li>
 * </ul>
 *
 * <p><b>为什么用真实 DDL</b>：建库脚本取自仓库真源 {@code src/main/resources/db/h2/V1__schema.sql}
 * （{@code --ddl}），所以 CLOB 列、时间列、唯一索引都是被测实现的那一份，不是另写一份简化表。</p>
 *
 * <p><b>口径</b>：堆每 10ms 采样一次（{@code --heapCsv}），工作集由编排脚本每 100ms 采样，
 * GC 日志由 JVM 的 {@code -Xlog:gc*} 落盘。峰值取自采样值，不看退出码。</p>
 *
 * <p>用法：</p>
 * <pre>
 * java -Xmx512m -cp &lt;h2.jar&gt; tools/oom/CheckpointReplay.java \
 *   --mode=file --scenario=pre --out=%TEMP%/... --fixtures=&lt;只读夹具目录&gt; \
 *   --ddl=src/main/resources/db/h2/V1__schema.sql --rounds=30 --pause=500 --contextEvery=5 --workers=1
 * </pre>
 */
public final class CheckpointReplay {

    /** 事故前最近可读的根执行正文（8,228,383 字节，379 条消息）。 */
    private static final String PRE_EXECUTION = "execution-2116061030625996800.json";
    /** 根上下文（10,876,478 字节，427 条消息）。 */
    private static final String ROOT_CONTEXT = "context-2115988021194158080.json";
    /** 重建样本的字节数：与历史 reconstructed 场景同量级（14,988,752）。 */
    private static final long RECONSTRUCTED_BYTES = 14_988_752L;

    private static final long SAMPLE_INTERVAL_MILLIS = 10L;

    private static final MemoryMXBean MEMORY = ManagementFactory.getMemoryMXBean();
    private static final AtomicLong PEAK_HEAP = new AtomicLong();
    private static final AtomicBoolean RUNNING = new AtomicBoolean(true);
    private static final AtomicLong SAVED = new AtomicLong();
    private static final AtomicLong CONTEXT_WRITES = new AtomicLong();
    private static final AtomicReference<String> FAILURE = new AtomicReference<>();

    private CheckpointReplay() {
    }

    public static void main(String[] args) {
        Map<String, String> options = parse(args);
        long startedAt = System.currentTimeMillis();
        Path out = Path.of(required(options, "out"));
        String mode = options.getOrDefault("mode", "file");
        String scenario = options.getOrDefault("scenario", "pre");
        int rounds = Integer.parseInt(options.getOrDefault("rounds", "30"));
        long pause = Long.parseLong(options.getOrDefault("pause", "500"));
        int contextEvery = Integer.parseInt(options.getOrDefault("contextEvery", "5"));
        int workers = Integer.parseInt(options.getOrDefault("workers", "1"));
        int heapMiB = (int) (Runtime.getRuntime().maxMemory() / 1048576L);
        try {
            Files.createDirectories(out);
            if (Files.exists(out.resolve("replay.mv.db"))) {
                throw new IllegalStateException("重放目录必须是全新的（发现旧库）: " + out);
            }
            int retainedCheckpoints;
            System.out.println("REPLAY pid=" + ProcessHandle.current().pid() + ", mode=" + mode
                    + ", scenario=" + scenario + ", rounds=" + rounds + ", pause=" + pause
                    + ", contextEvery=" + contextEvery + ", workers=" + workers
                    + ", xmxMiB=" + heapMiB);
            Thread sampler = startHeapSampler(out.resolve("heap.csv"));
            try (Connection connection = open(out)) {
                applyDdl(connection, required(options, "ddl"), mode);
                Fixtures fixtures = Fixtures.load(required(options, "fixtures"), scenario, out);
                List<Long> executions = seed(connection, fixtures, workers, mode);
                System.out.println("SEEDED executions=" + executions + ", fixtureBytes=" + fixtures.executionBytes
                        + ", contextBytes=" + fixtures.contextText.length());
                // 建库流量不能混进业务负载：先等写盘静默，再开始计时。
                sleep(2000);
                retainedCheckpoints = run(connection, fixtures, executions, mode, scenario, rounds, pause, contextEvery);
            } finally {
                RUNNING.set(false);
                sampler.join(2000);
            }
            long elapsed = System.currentTimeMillis() - startedAt;
            long peakMiB = PEAK_HEAP.get() / 1048576L;
            long fullGc = fullGcCount();
            long gcMillis = totalGcMillis();
            String failure = FAILURE.get();
            boolean oom = failure != null && failure.startsWith("OOM");
            System.out.println("RESULT mode=" + mode + ", scenario=" + scenario + ", heapMiB=" + heapMiB
                    + ", peakHeapMiB=" + peakMiB + ", saved=" + SAVED.get()
                    + ", contextWrites=" + CONTEXT_WRITES.get() + ", retainedCheckpoints=" + retainedCheckpoints
                    + ", failures=" + (failure == null ? 0 : 1)
                    + ", oom=" + oom + ", fullGc=" + fullGc + ", gcMillis=" + gcMillis
                    + ", elapsedMillis=" + elapsed + ", failure=" + (failure == null ? "none" : failure));
            if (failure != null) {
                System.exit(3);
            }
        } catch (Throwable error) {
            String classified = classify(error);
            FAILURE.compareAndSet(null, classified);
            boolean oom = classified.startsWith("OOM") || classified.startsWith("GC-overhead");
            long elapsed = System.currentTimeMillis() - startedAt;
            // 即使中途炸掉也要把数据行写出来：判据是「扫描器结论 + 数据表」，不是退出码。
            System.out.println("RESULT mode=" + mode + ", scenario=" + scenario + ", heapMiB=" + heapMiB
                    + ", peakHeapMiB=" + (PEAK_HEAP.get() / 1048576L) + ", saved=" + SAVED.get()
                    + ", contextWrites=" + CONTEXT_WRITES.get() + ", failures=1, oom=" + oom
                    + ", fullGc=" + fullGcCount() + ", gcMillis=" + totalGcMillis()
                    + ", elapsedMillis=" + elapsed + ", failure=" + classified);
            System.out.println("ABORT " + error.getClass().getName() + ": " + error.getMessage());
            error.printStackTrace(System.out);
            System.exit(oom ? 3 : 4);
        }
    }

    // ------------------------------------------------------------------ 建库与装载

    private static Connection open(Path out) throws SQLException {
        String base = out.resolve("replay").toAbsolutePath().normalize().toString().replace('\\', '/');
        // 与生产同源的连接参数：UTC 时区、不落 .trace.db、文件锁、退出不抢锁。
        String url = "jdbc:h2:file:" + base
                + ";DB_CLOSE_ON_EXIT=FALSE"
                + ";FILE_LOCK=FS"
                + ";AUTO_SERVER=FALSE"
                + ";TRACE_LEVEL_FILE=0"
                + ";INIT=SET TIME ZONE 'UTC'";
        return DriverManager.getConnection(url, "sa", "");
    }

    /** 执行仓库真源的 H2 基线脚本；正对照额外加回「整段 VARCHAR」列。 */
    private static void applyDdl(Connection connection, String ddlPath, String mode) throws Exception {
        String script = Files.readString(Path.of(ddlPath), StandardCharsets.UTF_8);
        StringBuilder withoutComments = new StringBuilder(script.length());
        for (String line : script.split("\n")) {
            String trimmed = line.strip();
            if (trimmed.startsWith("--") || trimmed.isEmpty()) {
                continue;
            }
            int comment = line.indexOf("--");
            withoutComments.append(comment >= 0 ? line.substring(0, comment) : line).append('\n');
        }
        try (Statement statement = connection.createStatement()) {
            for (String sql : withoutComments.toString().split(";")) {
                if (sql.isBlank()) {
                    continue;
                }
                statement.execute(sql.strip());
            }
            if ("varchar".equals(mode)) {
                // 正对照：把检查点正文改回整段字符串列（旧事故形态，§附录E.4）。
                statement.execute("ALTER TABLE execution ADD COLUMN snapshot"
                        + " CHARACTER VARYING(1000000000) NULL");
            }
        }
    }

    private static List<Long> seed(Connection connection, Fixtures fixtures, int workers, String mode)
            throws SQLException {
        List<Long> ids = new ArrayList<>();
        try (PreparedStatement session = connection.prepareStatement(
                "INSERT INTO session (id, name, context_ratio) VALUES (?, ?, ?)");
             PreparedStatement execution = connection.prepareStatement(
                     "INSERT INTO execution (id, version, session_id, status, resume_generation) VALUES (?, 1, ?, 1, 0)");
             PreparedStatement context = connection.prepareStatement(
                     "INSERT INTO session_context (session_id, content, version) VALUES (?, ?, 1)")) {
            for (int index = 0; index < workers; index++) {
                long sessionId = 9_000_000L + index;
                session.setLong(1, sessionId);
                session.setString(2, "oom-replay-" + index);
                session.setDouble(3, 0.09512015503875969d);
                session.executeUpdate();
                long executionId = 8_000_000L + index;
                execution.setLong(1, executionId);
                execution.setLong(2, sessionId);
                execution.executeUpdate();
                context.setLong(1, sessionId);
                context.setString(2, fixtures.contextText);
                context.executeUpdate();
                ids.add(executionId);
            }
        }
        return ids;
    }

    // ------------------------------------------------------------------ 负载

    private static int run(Connection connection, Fixtures fixtures, List<Long> executions, String mode,
                            String scenario, int rounds, long pause, int contextEvery)
            throws Exception {
        // 旧仓储按执行 ID 替换已提交快照，不能把每轮历史都留在堆里制造额外泄漏。
        Map<Long, String> wholeJsonCache = new LinkedHashMap<>();
        List<Runnable> tasks = new ArrayList<>();
        for (int index = 0; index < executions.size(); index++) {
            long executionId = executions.get(index);
            long sessionId = 9_000_000L + index;
            int roundsForWorker = "recovered".equals(scenario) ? Math.max(1, rounds * 2 / 3) : rounds;
            tasks.add(() -> replay(connection, fixtures, executionId, sessionId, mode, roundsForWorker,
                    pause, contextEvery, wholeJsonCache));
        }
        // 这里只覆盖串行负载，不能用 workers 数量冒充并发验收。
        for (Runnable task : tasks) {
            task.run();
        }
        System.out.println("PHASE=DONE saved=" + SAVED.get() + ", contextWrites=" + CONTEXT_WRITES.get());
        return wholeJsonCache.size();
    }

    private static void replay(Connection connection, Fixtures fixtures, long executionId, long sessionId,
                               String mode, int rounds, long pause, int contextEvery, Map<Long, String> wholeJsonCache) {
        String fileSql = "UPDATE execution SET version = version + 1, snapshot_file = ? WHERE id = ?";
        String varcharSql = "UPDATE execution SET version = version + 1, snapshot = ? WHERE id = ?";
        String contextSql = "UPDATE session_context SET content = ?, version = version + 1 WHERE session_id = ?";
        try (PreparedStatement save = connection.prepareStatement("file".equals(mode) ? fileSql : varcharSql);
             PreparedStatement context = connection.prepareStatement(contextSql)) {
            for (int round = 1; round <= rounds; round++) {
                // 每一轮都写一份与原始正文同尺寸的检查点（旧实现每轮重新序列化整段 Execution）。
                String body = fixtures.body();
                if ("file".equals(mode)) {
                    Path target = fixtures.checkpointFile(executionId, round);
                    writeAtomically(target, body);
                    save.setString(1, target.getFileName().toString());
                } else {
                    save.setString(1, body);
                }
                save.setLong(2, executionId);
                save.executeUpdate();
                if ("varchar".equals(mode)) {
                    // 用独立字符串模拟每次序列化，只保留每个执行最后一次成功提交的结果。
                    wholeJsonCache.put(executionId, body.concat(" "));
                }
                SAVED.incrementAndGet();
                if (contextEvery > 0 && round % contextEvery == 0) {
                    context.setString(1, fixtures.context());
                    context.setLong(2, sessionId);
                    context.executeUpdate();
                    CONTEXT_WRITES.incrementAndGet();
                }
                System.out.println("PHASE=ROUND execution=" + executionId + ", round=" + round
                        + ", usedMiB=" + MEMORY.getHeapMemoryUsage().getUsed() / 1048576L);
                if (pause > 0) {
                    sleep(pause);
                }
            }
        } catch (Throwable error) {
            FAILURE.compareAndSet(null, classify(error));
            System.out.println("FAILURE execution=" + executionId + ", " + classify(error));
            error.printStackTrace(System.out);
        }
    }

    private static void writeAtomically(Path target, String body) throws IOException {
        Files.createDirectories(target.getParent());
        Path temp = target.resolveSibling(target.getFileName() + ".tmp");
        Files.writeString(temp, body, StandardCharsets.UTF_8);
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException fallback) {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // ------------------------------------------------------------------ 采样与度量

    private static Thread startHeapSampler(Path csv) throws IOException {
        BufferedWriter writer = Files.newBufferedWriter(csv, StandardCharsets.UTF_8);
        writer.write("millis,usedBytes\n");
        Thread thread = new Thread(() -> {
            long started = System.currentTimeMillis();
            try {
                while (RUNNING.get()) {
                    long used = MEMORY.getHeapMemoryUsage().getUsed();
                    PEAK_HEAP.accumulateAndGet(used, Math::max);
                    writer.write((System.currentTimeMillis() - started) + "," + used + "\n");
                    Thread.sleep(SAMPLE_INTERVAL_MILLIS);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (IOException ignored) {
                // 采样写盘失败不掩盖被测结论。
            } finally {
                try {
                    writer.close();
                } catch (IOException ignored) {
                    // 同上。
                }
            }
        }, "heap-sampler");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private static long fullGcCount() {
        long total = 0L;
        for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
            String name = bean.getName().toLowerCase(Locale.ROOT);
            if (name.contains("old") || name.contains("marksweep") || name.contains("full")) {
                total += Math.max(bean.getCollectionCount(), 0L);
            }
        }
        return total;
    }

    private static long totalGcMillis() {
        long total = 0L;
        for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
            total += Math.max(bean.getCollectionTime(), 0L);
        }
        return total;
    }

    /** 失败分类：OOM 与锁冲突必须分开，不能把锁超时写成 OOM。 */
    private static String classify(Throwable error) {
        // 先整链找 OOM：H2 会把 OutOfMemoryError 包在 SQLException 里（message 里带着类名），
        // 只按异常类型判会把它误判成 H2-error，失败类别就会写错。
        for (Throwable cursor = error; cursor != null; cursor = cursor.getCause()) {
            String message = String.valueOf(cursor.getMessage());
            if (cursor instanceof OutOfMemoryError
                    || message.contains("OutOfMemoryError")
                    || message.contains("GC overhead limit exceeded")) {
                if (message.contains("GC overhead limit exceeded")) {
                    return "GC-overhead: " + message;
                }
                return "OOM-heap: " + cursor.getClass().getName() + ": "
                        + (message.length() > 200 ? message.substring(0, 200) : message);
            }
        }
        for (Throwable cursor = error; cursor != null; cursor = cursor.getCause()) {
            if (cursor instanceof SQLException sql) {
                String message = String.valueOf(sql.getMessage());
                if (message.contains("Timeout trying to lock") || message.contains("Deadlock")
                        || message.contains("50200")) {
                    return "H2-lock: " + message;
                }
                return "H2-error: " + message;
            }
        }
        return "harness-error: " + error.getClass().getName() + ": " + error.getMessage();
    }

    // ------------------------------------------------------------------ 夹具

    /** 只读夹具：执行正文与上下文都来自事故现场导出，内容不扩写、不截断。 */
    private static final class Fixtures {
        private final String executionText;
        private final String contextText;
        private final long executionBytes;
        private final Path checkpointRoot;

        private Fixtures(String executionText, String contextText, long executionBytes, Path checkpointRoot) {
            this.executionText = executionText;
            this.contextText = contextText;
            this.executionBytes = executionBytes;
            this.checkpointRoot = checkpointRoot;
        }

        static Fixtures load(String directory, String scenario, Path out) throws IOException {
            Path root = Path.of(directory);
            Path execution;
            if ("recovered".equals(scenario)) {
                List<Path> candidates = new ArrayList<>();
                try (Stream<Path> files = Files.list(root)) {
                    candidates.addAll(files
                            .filter(path -> path.getFileName().toString().startsWith("execution-"))
                            .sorted(Comparator.comparingLong(CheckpointReplay::sizeOrZero).reversed())
                            .limit(3)
                            .toList());
                }
                execution = candidates.isEmpty() ? root.resolve(PRE_EXECUTION) : candidates.get(0);
            } else {
                execution = root.resolve(PRE_EXECUTION);
            }
            String executionText = Files.readString(execution, StandardCharsets.UTF_8);
            long executionBytes = Files.size(execution);
            String contextText = Files.readString(root.resolve(ROOT_CONTEXT), StandardCharsets.UTF_8);
            if ("reconstructed".equals(scenario)) {
                contextText = reconstruct(contextText, RECONSTRUCTED_BYTES);
            }
            // 检查点正文落在本次运行的隔离目录里，绝不写进只读夹具目录。
            Path checkpointRoot = out.resolve("data").resolve("checkpoints");
            return new Fixtures(executionText, contextText, executionBytes, checkpointRoot);
        }

        /**
         * 重建样本：用幸存上下文循环拼到 14,988,752 字节。
         *
         * <p><b>边界必须写清</b>：原始 reconstructed 样本（丢失执行的辅助重建文件）不在可复制的
         * {@code replay-fixtures} 里，这里只用幸存上下文循环拼接，<b>尺寸对齐、内容不等价</b>，
         * 因此本组只用于「同量级负载下的内存形态」，不能当成那份原始样本的逐字重放。</p>
         */
        private static String reconstruct(String seed, long targetBytes) {
            StringBuilder builder = new StringBuilder((int) Math.min(targetBytes + 1024, Integer.MAX_VALUE - 8));
            while (builder.length() < targetBytes) {
                builder.append(seed);
            }
            builder.setLength((int) targetBytes);
            return builder.toString();
        }

        /** 复用输入以隔离存储负载；这里不覆盖真实 Execution 的序列化与恢复开销。 */
        String body() {
            return executionText;
        }

        /** 上下文整段替换的正文；同样复用实例，理由见 {@link #body()}。 */
        String context() {
            return contextText;
        }

        Path checkpointFile(long executionId, int round) {
            return checkpointRoot.resolve(String.valueOf(executionId)).resolve("ck-" + round + ".json");
        }
    }

    private static long sizeOrZero(Path path) {
        try {
            return Files.size(path);
        } catch (IOException ignored) {
            return 0L;
        }
    }

    // ------------------------------------------------------------------ 工具

    private static Map<String, String> parse(String[] args) {
        Map<String, String> options = new LinkedHashMap<>();
        for (String arg : args) {
            if (!arg.startsWith("--")) {
                continue;
            }
            int equals = arg.indexOf('=');
            if (equals < 0) {
                options.put(arg.substring(2), "true");
            } else {
                options.put(arg.substring(2, equals), arg.substring(equals + 1));
            }
        }
        return options;
    }

    private static String required(Map<String, String> options, String key) {
        String value = options.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("缺少参数 --" + key + "=");
        }
        return value;
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}

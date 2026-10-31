package com.summit.dp.execution.infrastructure.checkpoint;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 检查点正文的本地文件实现。
 *
 * <p>目录：{@code <数据目录>/checkpoints/<executionId>/<文件标识>.json}。</p>
 *
 * <p><b>保存顺序（不可省略任何一步）</b>：</p>
 * <ol>
 *   <li>流式写入同一目录下的独立临时文件（{@code .part}），全程不产生完整字符串或字节数组；</li>
 *   <li>关闭并 flush/fsync 后 {@code ATOMIC_MOVE} 发布成新的独立文件名（不覆盖旧文件）；</li>
 *   <li>由调用方通过数据库版本条件提交「新文件标识 + 状态 + resume_generation」；</li>
 *   <li>提交后删除旧文件；回滚时删除本次新文件。</li>
 * </ol>
 *
 * <p><b>在途登记</b>：从 {@link #begin(String)} 到事务完成之间，文件标识一直登记在途，
 * 清理逻辑据此跳过「已发布但尚未提交」的文件 —— 否则提交前被删会造成库内引用了不存在的正文。</p>
 */
@Slf4j
@Component
public class LocalFileCheckpointStore implements ExecutionCheckpointStore {

    /** 执行标识只允许数字：它直接参与目录名，禁止任何路径分隔或上跳。 */
    private static final Pattern EXECUTION_ID = Pattern.compile("^[0-9]{1,19}$");
    /** 文件标识只允许 32 位小写十六进制（UUID 去连字符），不接受用户输入以外的一切形态。 */
    private static final Pattern FILE_ID = Pattern.compile("^[0-9a-f]{32}$");
    private static final String SUFFIX = ".json";
    private static final String TEMP_SUFFIX = ".part";
    /** 单批枚举上限：目录项多时也只占很小一段内存。 */
    private static final int MAX_BATCH = 500;
    /** 迁移复制等待静默窗口的上限；等不到就让用户稍后重试，而不是复制出半新半旧的数据集。 */
    private static final long DEFAULT_COPY_QUIET_WINDOW_SECONDS = 10L;

    private final Path root;
    private final ObjectMapper mapper;
    /** 等待「检查点写入静默窗口」的秒数：迁移复制要在这个窗口里做。 */
    private final long copyQuietWindowSeconds;
    /** 在途写入登记：executionId → 尚未完成事务的文件标识集合。 */
    private final Map<String, Set<String>> inFlight = new ConcurrentHashMap<>();
    /** 测试专用「释放窗口」回调；生产恒为 {@code null}（见 {@link #setReleaseWindowHook}）。 */
    private volatile Runnable releaseWindowHook;
    /**
     * 读写门闩：写入与删除取读锁（可并发），目录复制取写锁（独占）。
     *
     * <p>复制期间必须没有检查点写入 —— 否则会复制出「库快照指向的文件已被替换/删除」的数据集。
     * 写锁拿不到就明确失败，不冒险复制。</p>
     */
    private final ReentrantReadWriteLock gate = new ReentrantReadWriteLock();

    /**
     * 生产装配入口：数据目录来自 {@code lingxi.data.dir}，静默窗口用默认 10 秒。
     *
     * <p>显式 {@code @Autowired}：类里还有一个「指定静默窗口」的构造器供测试使用，
     * 不标出来 Spring 会在两个构造器之间选不出来。</p>
     */
    @org.springframework.beans.factory.annotation.Autowired
    public LocalFileCheckpointStore(@Value("${lingxi.data.dir}") String dataDir, ObjectMapper mapper) {
        this(dataDir, mapper, DEFAULT_COPY_QUIET_WINDOW_SECONDS);
    }

    /**
     * 指定「等待检查点写入静默窗口」的秒数。
     *
     * <p>生产用默认 10 秒；测试与需要快速失败的场景传 0，表示「拿不到就立刻拒绝」。</p>
     */
    public LocalFileCheckpointStore(String dataDir, ObjectMapper mapper, long quietWindowSeconds) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve("checkpoints");
        this.mapper = mapper;
        this.copyQuietWindowSeconds = Math.max(0L, quietWindowSeconds);
    }

    @Override
    public CheckpointWriter begin(String executionId) {
        Path directory = executionDirectory(executionId);
        String fileId = UUID.randomUUID().toString().replace("-", "");
        // 写入期间持读锁：目录复制（迁移）会取写锁，两者互斥，复制出来的检查点目录一定是静止状态。
        gate.readLock().lock();
        try {
            Files.createDirectories(directory);
            // 临时文件与最终文件同目录：保证 ATOMIC_MOVE 一定在同一文件系统内。
            Path temp = Files.createTempFile(directory, fileId + "-", TEMP_SUFFIX);
            register(executionId, fileId);
            return new FileCheckpointWriter(executionId, fileId, temp, directory.resolve(fileId + SUFFIX));
        } catch (IOException e) {
            gate.readLock().unlock();
            throw new UncheckedIOException("创建检查点临时文件失败: executionId=" + executionId, e);
        } catch (RuntimeException e) {
            gate.readLock().unlock();
            throw e;
        }
    }

    @Override
    public <T> T read(String executionId, String fileId, Class<T> type) {
        Path file = resolve(executionId, fileId);
        if (!Files.isRegularFile(file)) {
            // 明确失败：绝不静默改读旧版本或返回空壳，否则调用方会拿着半截历史继续跑。
            throw new IllegalStateException("执行检查点文件不存在: executionId=" + executionId
                    + ", fileId=" + fileId);
        }
        try (InputStream in = Files.newInputStream(file)) {
            // 流式反序列化：正文不整体落到字符串/字节数组，也不做 JsonNode 树中转。
            return mapper.readValue(in, type);
        } catch (IOException e) {
            throw new IllegalStateException("执行检查点无法解析: executionId=" + executionId
                    + ", fileId=" + fileId, e);
        }
    }

    @Override
    public boolean delete(String executionId, String fileId) {
        if (fileId == null || !FILE_ID.matcher(fileId).matches()) {
            return false;
        }
        if (isInFlight(executionId, fileId)) {
            // 在途写入可能正在被另一个线程发布：让清理跳过，绝不删。
            return false;
        }
        gate.readLock().lock();
        try {
            return Files.deleteIfExists(resolve(executionId, fileId));
        } catch (IOException | RuntimeException failure) {
            // 已经提交成功，删不掉只是垃圾文件：记录后留给后续清理，不改变保存结果。
            log.warn("删除执行检查点文件失败，留待后续清理: executionId={}, fileId={}, error={}",
                    executionId, fileId, failure.toString());
            return false;
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 回收一个执行目录：只有目录已经空了才删。
     *
     * <p>用 {@code Files.deleteIfExists} 的语义直接拿到「非空就失败」的保证：不用先列目录再删，
     * 也就不存在「列的时候是空的、删的时候刚被写进一个文件」的误删窗口。</p>
     */
    @Override
    public boolean deleteExecutionDirectoryIfEmpty(String executionId) {
        Path directory = executionDirectory(executionId);
        gate.readLock().lock();
        try {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                return false;
            }
            return Files.deleteIfExists(directory);
        } catch (java.nio.file.DirectoryNotEmptyException notEmpty) {
            // 目录里还有正文（可能是权威引用的那份）：绝不删。
            return false;
        } catch (IOException | RuntimeException failure) {
            log.warn("回收空执行目录失败，留待下一轮: directory={}, error={}", directory, failure.toString());
            return false;
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 文件侧是否还有可能要回收的内容：只列 {@code checkpoints/} 根一层，不读正文。
     *
     * <p>便宜的判定，故意偏向「可能需要」：清理预览必须能把「没有可回收的数据库行」与
     * 「文件侧没有要扫描的东西」分开，否则只剩孤儿文件时界面会误以为无事可做。</p>
     */
    @Override
    public boolean hasUnscannedFiles() {
        if (!Files.isDirectory(root)) {
            return false;
        }
        gate.readLock().lock();
        try (Stream<Path> children = Files.list(root)) {
            return children.anyMatch(LocalFileCheckpointStore::isScannable);
        } catch (IOException e) {
            // 枚举失败按「可能还有」处理：宁可让用户再点一次清理，也不要吞掉垃圾文件。
            log.warn("探测检查点目录失败，按仍需扫描处理: root={}, error={}", root, e.toString());
            return true;
        } finally {
            gate.readLock().unlock();
        }
    }

    /** 执行目录或未完成的临时文件都算「需要扫描」；其它条目（陌生文件）不算。 */
    private static boolean isScannable(Path path) {
        String name = path.getFileName().toString();
        if (name.endsWith(TEMP_SUFFIX)) {
            return Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS);
        }
        return EXECUTION_ID.matcher(name).matches() && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS);
    }

    @Override
    public boolean isInFlight(String executionId, String fileId) {
        Set<String> pending = inFlight.get(executionId);
        return pending != null && fileId != null && pending.contains(fileId);
    }

    @Override
    public Set<String> inFlightFileIds(String executionId) {
        Set<String> pending = inFlight.get(executionId);
        return pending == null ? Set.of() : Set.copyOf(new LinkedHashSet<>(pending));
    }

    /**
     * 按批枚举执行目录：只看根目录下的直接子目录，名字必须是数字执行标识。
     *
     * <p>不跟符号链接：链接可能指到用户数据目录（images 等）之外，甚至形成环。
     * {@code afterExecutionId} 用数字大小比较，目录只会因为新执行而变大，不会漏扫。</p>
     */
    @Override
    public List<String> listExecutionIds(String afterExecutionId, int limit) {
        int size = clampBatch(limit);
        long after = parseOrZero(afterExecutionId);
        if (!Files.isDirectory(root)) {
            return List.of();
        }
        gate.readLock().lock();
        try (Stream<Path> children = Files.list(root)) {
            List<String> ids = children
                    .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                    .map(path -> path.getFileName().toString())
                    .filter(name -> EXECUTION_ID.matcher(name).matches())
                    .filter(name -> parseOrZero(name) > after)
                    .sorted(Comparator.comparingLong(Long::parseLong))
                    .limit(size)
                    .toList();
            return new ArrayList<>(ids);
        } catch (IOException e) {
            log.warn("枚举检查点执行目录失败，跳过本轮: root={}, error={}", root, e.toString());
            return List.of();
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 按批枚举某个执行目录下的文件：只读文件名，不打开任何文件。
     *
     * <p>临时文件（{@code <fileId>-<random>.part}）单独标记，清理据此回收未完成的写入；
     * 其它不认识的文件一律不返回 —— 清理绝不删自己不认识的条目。</p>
     */
    @Override
    public List<CheckpointFile> listFiles(String executionId, int limit) {
        Path directory = executionDirectory(executionId);
        int size = clampBatch(limit);
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            return List.of();
        }
        gate.readLock().lock();
        try (Stream<Path> children = Files.list(directory)) {
            return children
                    .filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .map(path -> entryOf(executionId, path.getFileName().toString()))
                    .filter(java.util.Objects::nonNull)
                    .limit(size)
                    .toList();
        } catch (IOException e) {
            log.warn("枚举检查点文件失败，跳过该执行: executionId={}, error={}", executionId, e.toString());
            return List.of();
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 删除枚举出来的条目：只认 {@link #listFiles(String, int)} 的产物，按精确文件名删。
     *
     * <p>在途写入一律跳过；文件名与执行目录都要重新校验，防止调用方传入越界路径。</p>
     */
    @Override
    public boolean deleteFile(CheckpointFile file) {
        if (file == null || file.executionId() == null || file.fileName() == null) {
            return false;
        }
        if (file.fileName().contains("/") || file.fileName().contains("\\") || file.fileName().contains("..")) {
            return false;
        }
        if (!FILE_ID.matcher(file.fileId() == null ? "" : file.fileId()).matches()) {
            return false;
        }
        if (isInFlight(file.executionId(), file.fileId())) {
            return false;
        }
        Path directory = executionDirectory(file.executionId());
        Path candidate = directory.resolve(file.fileName()).normalize();
        if (!candidate.startsWith(directory)) {
            return false;
        }
        gate.readLock().lock();
        try {
            return Files.deleteIfExists(candidate);
        } catch (IOException | RuntimeException failure) {
            log.warn("回收检查点文件失败，留待下一轮: path={}, error={}", candidate, failure.toString());
            return false;
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 把检查点目录复制到新数据目录，复制期间排除检查点写入与删除。
     *
     * <p>只复制已发布的 {@code .json}：临时文件属于尚未提交的事务，复制过去也只是垃圾，
     * 重启后由清理回收。源目录只读不删 —— 搬迁失败时旧目录必须完好。</p>
     */
    @Override
    public CopyResult copyTo(String targetDataDir) {
        if (targetDataDir == null || targetDataDir.isBlank()) {
            throw new IllegalArgumentException("目标数据目录不能为空");
        }
        Path targetRoot = Path.of(targetDataDir).toAbsolutePath().normalize().resolve("checkpoints");
        acquireWriteQuiesce("检查点目录复制被中断");
        try {
            return copyLocked(targetRoot);
        } finally {
            gate.writeLock().unlock();
        }
    }

    /**
     * 在写锁保护的静止窗口里执行搬迁动作（库快照 + 目录复制必须同一窗口）。
     *
     * <p>写锁可重入：动作内部再调 {@link #copyTo(String)} 不会自己把自己锁死。</p>
     */
    @Override
    public void withWriteQuiesced(Runnable migrationStep) {
        if (migrationStep == null) {
            throw new IllegalArgumentException("搬迁动作不能为空");
        }
        acquireWriteQuiesce("数据目录迁移被中断");
        try {
            migrationStep.run();
        } finally {
            gate.writeLock().unlock();
        }
    }

    /**
     * 取得「排除检查点写入」的独占窗口；等不到就明确失败，不冒险在写入进行中复制或搬迁。
     *
     * <p>调用方拿到即持有写锁，必须自己 {@code unlock}；本方法抛错时不持锁。</p>
     *
     * @param interruptedMessage 被中断时的失败文案（复制与搬迁各自区分）
     * @throws IllegalStateException 等不到静默窗口，或被中断
     */
    private void acquireWriteQuiesce(String interruptedMessage) {
        boolean locked;
        try {
            locked = gate.writeLock().tryLock(copyQuietWindowSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interruptedMessage);
        }
        if (!locked) {
            throw new IllegalStateException("仍有检查点正在写入，请稍后重试数据目录迁移");
        }
    }

    /** 只在已持写锁时调用：把已发布的正文复制到目标目录。 */
    private CopyResult copyLocked(Path targetRoot) {
        try {
            if (!Files.isDirectory(root)) {
                Files.createDirectories(targetRoot);
                return new CopyResult(0, 0);
            }
            int copied = 0;
            int skippedTemporary = 0;
            try (Stream<Path> paths = Files.walk(root)) {
                List<Path> entries = paths.sorted(Comparator.naturalOrder()).toList();
                for (Path entry : entries) {
                    Path destination = targetRoot.resolve(root.relativize(entry).toString());
                    if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
                        Files.createDirectories(destination);
                        continue;
                    }
                    if (!Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)) {
                        continue;
                    }
                    if (entry.getFileName().toString().endsWith(TEMP_SUFFIX)) {
                        skippedTemporary++;
                        continue;
                    }
                    if (!entry.getFileName().toString().endsWith(SUFFIX)) {
                        continue;
                    }
                    Files.createDirectories(destination.getParent());
                    Files.copy(entry, destination, StandardCopyOption.REPLACE_EXISTING);
                    copied++;
                }
            }
            log.info("检查点目录复制完成: from={}, to={}, copied={}, skippedTemporary={}",
                    root, targetRoot, copied, skippedTemporary);
            return new CopyResult(copied, skippedTemporary);
        } catch (IOException e) {
            throw new IllegalStateException("检查点目录复制失败: " + e.getMessage(), e);
        }
    }

    /** 文件名 → 枚举条目；不认识的名字返回 {@code null}（清理不碰自己不认识的条目）。 */
    private static CheckpointFile entryOf(String executionId, String fileName) {
        if (fileName.endsWith(SUFFIX)) {
            String fileId = fileName.substring(0, fileName.length() - SUFFIX.length());
            return FILE_ID.matcher(fileId).matches()
                    ? new CheckpointFile(executionId, fileId, fileName, false) : null;
        }
        if (fileName.endsWith(TEMP_SUFFIX)) {
            // 临时文件名形如 <fileId>-<random>.part，取前缀当在途判据。
            int dash = fileName.indexOf('-');
            String fileId = dash > 0 ? fileName.substring(0, dash) : "";
            return FILE_ID.matcher(fileId).matches()
                    ? new CheckpointFile(executionId, fileId, fileName, true) : null;
        }
        return null;
    }

    private static int clampBatch(int limit) {
        return Math.clamp(limit, 1, MAX_BATCH);
    }

    private static long parseOrZero(String executionId) {
        if (executionId == null || !EXECUTION_ID.matcher(executionId).matches()) {
            return 0L;
        }
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException overflow) {
            // 19 位上限内理论上不会溢出；真溢出按「不前进」处理，宁可多扫一轮也不跳过。
            return 0L;
        }
    }

    /**
     * 结束在途登记并释放读锁；写入失败、事务提交或回滚都必须调用，避免清理永久跳过该标识。
     *
     * <p><b>为什么判空与移除键必须在同一个原子步骤里</b>：它们分散执行会被合法交错打穿 ——</p>
     * <pre>
     * A: 移除自己的标识 → 观察到集合为空
     * B: 开始并往<b>同一个集合</b>里登记新文件
     * A: remove(executionId, 集合)  ← 把含 B 的集合整个移除
     * 清理器: 把 B 已发布、尚未提交的文件当孤儿删掉 → B 提交后留下断链引用
     * </pre>
     *
     * <p>现在登记（{@link #register}）与释放都用 {@code ConcurrentHashMap.compute} 在同一个 key 上
     * 完成「增删元素 + 判空 + 移除键」，同一执行的这两步互斥且各自原子，上面那条交错不再存在。</p>
     */
    private void release(String executionId, String fileId) {
        try {
            inFlight.compute(executionId, (key, current) -> {
                if (current == null) {
                    return null;
                }
                current.remove(fileId);
                // 测试专用交错点：只在这一个原子步骤内部生效，生产恒为 null。
                Runnable window = releaseWindowHook;
                if (window != null) {
                    window.run();
                }
                return current.isEmpty() ? null : current;
            });
        } finally {
            gate.readLock().unlock();
        }
    }

    /**
     * 登记一个在途文件标识。
     *
     * <p>同样走 {@code compute}：如果只是「拿到集合再 add」，{@link #release} 可能在这个 add 之前
     * 就判定「集合为空」并移除键，登记便落在了一个已经脱离 map 的集合上 —— 清理器随即看不到它。</p>
     */
    private void register(String executionId, String fileId) {
        inFlight.compute(executionId, (key, current) -> {
            Set<String> next = current == null ? ConcurrentHashMap.newKeySet() : current;
            next.add(fileId);
            return next;
        });
    }

    /**
     * 测试专用：安装「释放窗口」回调，用来在原子步骤内部插入确定性调度点。
     *
     * <p>只供回归用例复现复核报告里的交错；生产不调用，字段保持 {@code null}，
     * 每次释放只多一次 volatile 读。</p>
     */
    void setReleaseWindowHook(Runnable hook) {
        this.releaseWindowHook = hook;
    }

    /** 解析并复核最终路径仍在该执行目录内（防路径穿越）。 */
    private Path resolve(String executionId, String fileId) {
        Path directory = executionDirectory(executionId);
        Path candidate = directory.resolve(fileId + SUFFIX).normalize();
        if (!candidate.startsWith(directory)) {
            throw new IllegalArgumentException("非法的执行检查点文件标识: fileId=" + fileId);
        }
        return candidate;
    }

    private Path executionDirectory(String executionId) {
        if (executionId == null || !EXECUTION_ID.matcher(executionId).matches()) {
            throw new IllegalArgumentException("非法的执行标识，检查点目录只接受数字: executionId=" + executionId);
        }
        Path directory = root.resolve(executionId).normalize();
        if (!directory.startsWith(root)) {
            throw new IllegalArgumentException("非法的执行标识: executionId=" + executionId);
        }
        return directory;
    }

    /** 单次写入的句柄：临时文件 → fsync → 原子发布。 */
    private final class FileCheckpointWriter implements CheckpointWriter {

        private final String executionId;
        private final String fileId;
        private final Path temp;
        private final Path target;
        private OutputStream stream;
        private boolean published;
        private boolean released;

        private FileCheckpointWriter(String executionId, String fileId, Path temp, Path target) {
            this.executionId = executionId;
            this.fileId = fileId;
            this.temp = temp;
            this.target = target;
            try {
                this.stream = new BufferedOutputStream(Files.newOutputStream(temp,
                        StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING));
            } catch (IOException e) {
                release();
                throw new UncheckedIOException("打开检查点临时文件失败: executionId=" + executionId, e);
            }
        }

        @Override
        public OutputStream stream() {
            return stream;
        }

        @Override
        public String fileId() {
            return fileId;
        }

        @Override
        public void publish() {
            if (published) {
                return;
            }
            try {
                stream.flush();
                // 先落盘再发布：断电后不会出现「数据库指向了内容不完整的文件」。
                try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                    channel.force(true);
                }
                stream.close();
                stream = OutputStream.nullOutputStream();
                move(temp, target);
                published = true;
            } catch (IOException e) {
                throw new UncheckedIOException("发布检查点文件失败: executionId=" + executionId, e);
            }
        }

        private void move(Path from, Path to) throws IOException {
            try {
                Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException unsupported) {
                // 同一目录内移动理论上一定支持原子语义；不支持时退化为普通移动并记录。
                log.warn("文件系统不支持原子移动，退化为普通移动: {}", to);
                Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
            }
        }

        @Override
        public void complete() {
            closeQuietly();
            release();
        }

        @Override
        public void rollback() {
            closeQuietly();
            Path leftover = published ? target : temp;
            try {
                Files.deleteIfExists(leftover);
            } catch (IOException failure) {
                // 回滚已经发生，垃圾文件留给后续清理，不能掩盖原始失败。
                log.warn("回滚后删除检查点文件失败，留待后续清理: {}, error={}", leftover, failure.toString());
            }
            release();
        }

        @Override
        public void close() {
            closeQuietly();
        }

        private void closeQuietly() {
            try {
                stream.close();
            } catch (IOException failure) {
                log.debug("关闭检查点写入流失败: {}", failure.toString());
            } finally {
                stream = OutputStream.nullOutputStream();
            }
        }

        private void release() {
            if (released) {
                return;
            }
            released = true;
            LocalFileCheckpointStore.this.release(executionId, fileId);
        }
    }
}

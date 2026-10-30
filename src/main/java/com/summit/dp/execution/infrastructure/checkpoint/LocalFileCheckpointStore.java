package com.summit.dp.execution.infrastructure.checkpoint;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

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

    private final Path root;
    private final ObjectMapper mapper;
    /** 在途写入登记：executionId → 尚未完成事务的文件标识集合。 */
    private final Map<String, Set<String>> inFlight = new ConcurrentHashMap<>();

    public LocalFileCheckpointStore(@Value("${lingxi.data.dir}") String dataDir, ObjectMapper mapper) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve("checkpoints");
        this.mapper = mapper;
    }

    @Override
    public CheckpointWriter begin(String executionId) {
        Path directory = executionDirectory(executionId);
        String fileId = UUID.randomUUID().toString().replace("-", "");
        try {
            Files.createDirectories(directory);
            // 临时文件与最终文件同目录：保证 ATOMIC_MOVE 一定在同一文件系统内。
            Path temp = Files.createTempFile(directory, fileId + "-", TEMP_SUFFIX);
            inFlight.computeIfAbsent(executionId, key -> ConcurrentHashMap.newKeySet()).add(fileId);
            return new FileCheckpointWriter(executionId, fileId, temp, directory.resolve(fileId + SUFFIX));
        } catch (IOException e) {
            throw new UncheckedIOException("创建检查点临时文件失败: executionId=" + executionId, e);
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
        try {
            return Files.deleteIfExists(resolve(executionId, fileId));
        } catch (IOException | RuntimeException failure) {
            // 已经提交成功，删不掉只是垃圾文件：记录后留给后续清理，不改变保存结果。
            log.warn("删除执行检查点文件失败，留待后续清理: executionId={}, fileId={}, error={}",
                    executionId, fileId, failure.toString());
            return false;
        }
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

    /** 结束在途登记；写入失败、事务提交或回滚都必须调用，避免清理永久跳过该标识。 */
    private void release(String executionId, String fileId) {
        Set<String> pending = inFlight.get(executionId);
        if (pending == null) {
            return;
        }
        pending.remove(fileId);
        if (pending.isEmpty()) {
            inFlight.remove(executionId, pending);
        }
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

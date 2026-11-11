package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Collection;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * 文件编辑基线的落盘：{@code <数据目录>/file-records/<executionId>/<recordId>.baseline}。
 *
 * <p>基线是这条链路唯一的超大字段，落 CLOB 会带来大 LOB 写放大，所以写文件、库里只留路径。</p>
 *
 * <p>先写 {@code .part} 再 {@code ATOMIC_MOVE}：半截基线会被当成完整内容参与重放，比没有基线危险得多。</p>
 */
@Slf4j
@Component
public class BaselineFileStore {

    private static final String SUFFIX = ".baseline";
    private static final String TEMP_SUFFIX = ".part";

    private final Path root;

    public BaselineFileStore(@Value("${lingxi.data.dir}") String dataDir) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve("file-records");
    }

    /**
     * 写入一份基线。
     *
     * @return 基线文件的绝对路径，供 {@code file_record.baseline_path} 引用
     * @throws UncheckedIOException 写盘失败：此时记录不能登记，否则会引用一个不存在的基线
     */
    public String write(String executionId, String recordId, String content) {
        Path target = resolve(executionId, recordId);
        Path directory = target.getParent();
        try {
            Files.createDirectories(directory);
            Path temp = directory.resolve(recordId + SUFFIX + TEMP_SUFFIX);
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return target.toString();
        } catch (IOException e) {
            throw new UncheckedIOException("写入文件编辑基线失败: " + target, e);
        }
    }

    /**
     * 读取基线正文。
     *
     * @return 基线内容；路径为空、文件不存在或读失败时为 {@code Optional.empty()}
     *         （调用方据此整条跳过，不做「当作空文件」的猜测）
     */
    public Optional<String> read(String path) {
        if (path == null || path.isBlank()) return Optional.empty();
        try {
            Path file = Path.of(path);
            return Files.isRegularFile(file)
                    ? Optional.of(Files.readString(file, StandardCharsets.UTF_8))
                    : Optional.empty();
        } catch (IOException e) {
            log.warn("读取文件编辑基线失败: path={}, reason={}", path, e.getMessage());
            return Optional.empty();
        }
    }

    /** 删除一份基线；文件本就不存在视为成功（清理必须幂等）。 */
    public void delete(String path) {
        if (path == null || path.isBlank()) return;
        try {
            Files.deleteIfExists(Path.of(path));
        } catch (IOException e) {
            log.warn("删除文件编辑基线失败: path={}, reason={}", path, e.getMessage());
        }
    }

    /** 删除一次执行的全部基线目录；同样幂等。 */
    public void deleteExecution(String executionId) {
        Path directory = root.resolve(executionId).normalize();
        if (!directory.startsWith(root) || directory.equals(root)) return;
        try (Stream<Path> entries = Files.list(directory)) {
            for (Path entry : entries.toList()) {
                Files.deleteIfExists(entry);
            }
            Files.deleteIfExists(directory);
        } catch (IOException e) {
            log.warn("删除文件编辑基线目录失败: executionId={}, reason={}", executionId, e.getMessage());
        }
    }

    /** 批量回收多个执行的基线目录；目录不存在算成功（清理必须幂等）。 */
    public void deleteExecutions(Collection<String> executionIds) {
        for (String executionId : executionIds) {
            deleteExecution(executionId);
        }
    }

    private Path resolve(String executionId, String recordId) {
        Path target = root.resolve(executionId).resolve(recordId + SUFFIX).normalize();
        if (!target.startsWith(root)) {
            throw new IllegalArgumentException("文件编辑基线路径越界: " + target);
        }
        return target;
    }
}

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

/**
 * 文件编辑基线的大文本落盘：{@code <数据目录>/file-records/<executionId>/<recordId>.baseline}。
 *
 * <p><b>为什么基线不落库</b>：基线是「本轮第一次改该文件之前的全文」，是这条链路里唯一的
 * 超大字段。落 CLOB 意味着每次工具收尾都要写一次大 LOB（写放大），还会把大文本压进库文件；
 * 落文件系统则是一次普通顺序写，库表里只留绝对路径，读单条记录时不会连带读基线。</p>
 *
 * <p><b>写入顺序</b>：先写临时文件再 {@code ATOMIC_MOVE} 发布。进程在中途被杀时，
 * 目录里最多留一个 {@code .part}，不会出现「路径已写入库、文件却只有半截」的坏基线 ——
 * 半截基线比没有基线危险得多：它会被当成完整内容参与重放，静默产出错误的差异。</p>
 *
 * <p><b>目录只认安全标识</b>：{@code executionId} 与 {@code recordId} 直接拼进路径，
 * 所以写入前拒绝任何分隔符与上跳，落点必须仍在根目录内。</p>
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
     * @return 基线内容；路径为空、文件不存在或读失败时返回 {@code Optional.empty()}
     *         （调用方据此整条跳过该记录，不做「当作空文件」的猜测）
     */
    public java.util.Optional<String> read(String path) {
        if (path == null || path.isBlank()) return java.util.Optional.empty();
        try {
            Path file = Path.of(path);
            return Files.isRegularFile(file)
                    ? java.util.Optional.of(Files.readString(file, StandardCharsets.UTF_8))
                    : java.util.Optional.empty();
        } catch (IOException e) {
            log.warn("读取文件编辑基线失败: path={}, reason={}", path, e.getMessage());
            return java.util.Optional.empty();
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
        try (var entries = Files.list(directory)) {
            for (Path entry : entries.toList()) {
                Files.deleteIfExists(entry);
            }
            Files.deleteIfExists(directory);
        } catch (IOException e) {
            log.warn("删除文件编辑基线目录失败: executionId={}, reason={}", executionId, e.getMessage());
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

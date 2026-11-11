package com.summit.dp.session.infrastructure.context;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.dp.session.application.port.SessionContextStore;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 模型上下文正文的本机实现：{@code <数据目录>/session-context/<sessionId>/<正文标识>.jsonl}。
 *
 * <p><b>为什么是 JSONL</b>：一行一条消息，读的时候逐行流式还原，不像单块 JSON 那样必须整段
 * 落成字符串；坏一行也能精确报到第几行，而不是让整份正文变成不可解释的一坨。</p>
 *
 * <p><b>为什么每次都换新标识</b>：{@code replace} 多数调用点本身跑在外层事务里，
 * 恒定文件名会让事务回滚变成「引用旧、内容新」。换新标识后，回滚时旧文件仍是权威内容，
 * 本次新文件由调用方按事务结果回收 —— 与检查点同一套语义。</p>
 */
@Slf4j
@Component
public class LocalSessionContextFileStore implements SessionContextStore {

    /** 目录名：正文与库分开存放，数据目录里一眼能看出哪些是库、哪些是正文。 */
    private static final String DIRECTORY = "session-context";
    private static final String SUFFIX = ".jsonl";
    private static final String TEMP_SUFFIX = ".part";
    /** 会话标识直接参与目录名，只接受数字（雪花 id），禁止任何路径分隔或上跳。 */
    private static final Pattern SESSION_ID = Pattern.compile("^[0-9]{1,19}$");
    /** 正文标识只接受 32 位小写十六进制（UUID 去连字符）。 */
    private static final Pattern BODY_ID = Pattern.compile("^[0-9a-f]{32}$");

    private final Path root;
    private final ObjectMapper mapper;

    public LocalSessionContextFileStore(@Value("${lingxi.data.dir}") String dataDir, ObjectMapper mapper) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve(DIRECTORY);
        this.mapper = mapper;
    }

    @Override
    public List<Message> read(long sessionId, String bodyId) {
        Path file = resolve(sessionId, bodyId);
        if (!Files.isRegularFile(file)) {
            // 库里指向的正文不存在属于数据损坏：明确失败，绝不返回空历史冒充「新会话」。
            throw new IllegalStateException("会话上下文文件不存在: sessionId=" + sessionId + ", bodyId=" + bodyId);
        }
        List<Message> messages = new ArrayList<>();
        int lineNumber = 0;
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                lineNumber++;
                if (line.isBlank()) {
                    continue;
                }
                messages.add(mapper.readValue(line, Message.class));
            }
        } catch (IOException failure) {
            // 坏在第几行必须说清楚：JSONL 的价值就在这里，含糊的「解析失败」等于没报。
            throw new IllegalStateException("会话上下文文件无法解析: sessionId=" + sessionId
                    + ", bodyId=" + bodyId + ", line=" + lineNumber, failure);
        }
        return messages;
    }

    @Override
    public String write(long sessionId, List<Message> messages) {
        String bodyId = UUID.randomUUID().toString().replace("-", "");
        Path directory = sessionDirectory(sessionId);
        Path target = directory.resolve(bodyId + SUFFIX);
        Path temp = null;
        try {
            Files.createDirectories(directory);
            // 临时文件与目标同目录：原子改名不能跨文件系统。
            temp = Files.createTempFile(directory, bodyId + "-", TEMP_SUFFIX);
            try (BufferedWriter writer = Files.newBufferedWriter(temp, StandardCharsets.UTF_8)) {
                for (Message message : messages) {
                    writer.write(mapper.writeValueAsString(message));
                    writer.write('\n');
                }
                writer.flush();
            }
            // 改名之后正文必须真的在盘上：不 fsync 就发布，断电会留下一个空文件。
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                channel.force(true);
            }
            publish(temp, target);
            return bodyId;
        } catch (IOException failure) {
            deleteQuietly(temp);
            deleteQuietly(target);
            throw new UncheckedIOException("会话上下文落盘失败: sessionId=" + sessionId, failure);
        }
    }

    @Override
    public void delete(long sessionId, String bodyId) {
        if (bodyId == null || !BODY_ID.matcher(bodyId).matches()) {
            return;
        }
        Path file = sessionDirectory(sessionId).resolve(bodyId + SUFFIX);
        try {
            Files.deleteIfExists(file);
            // 最后一份正文删掉后会话目录就是空壳，顺手回收，避免每轮替换都留下一个空目录。
            deleteDirectoryIfEmpty(sessionId);
        } catch (IOException | RuntimeException failure) {
            // 引用已经换掉了，删不掉只是垃圾：记录后留给后续清理，不能改变已提交的事实。
            log.warn("删除会话上下文文件失败，留待后续清理: sessionId={}, bodyId={}, error={}",
                    sessionId, bodyId, failure.toString());
        }
    }

    @Override
    public void deleteSessions(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        for (Long sessionId : sessionIds) {
            if (sessionId == null) {
                continue;
            }
            // 行已经删了，文件删不掉只是垃圾：记录后交给后续清理，不能让会话删除失败。
            try {
                deleteDirectory(sessionDirectory(sessionId));
            } catch (IOException | RuntimeException failure) {
                log.warn("删除会话上下文目录失败，留待后续清理: sessionId={}, error={}",
                        sessionId, failure.toString());
            }
        }
    }

    @Override
    public List<Long> listSessionIds(int limit) {
        if (!Files.isDirectory(root)) {
            return List.of();
        }
        try (Stream<Path> children = Files.list(root)) {
            return children
                    .filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                    .map(path -> path.getFileName().toString())
                    .filter(name -> SESSION_ID.matcher(name).matches())
                    .limit(Math.max(limit, 1))
                    .map(Long::parseLong)
                    .toList();
        } catch (IOException failure) {
            log.warn("枚举会话上下文目录失败，跳过本轮: root={}, error={}", root, failure.toString());
            return List.of();
        }
    }

    @Override
    public boolean deleteSessionDirectory(long sessionId, Instant idleBefore) {
        Path directory;
        try {
            directory = sessionDirectory(sessionId);
        } catch (RuntimeException illegal) {
            // 目录名非法：不是本实现的产物，绝不按它拼路径。
            return false;
        }
        try {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                return false;
            }
            if (!isIdleSince(directory, idleBefore)) {
                // 还有新文件：可能正处在「已落盘、尚未换引用」的窗口，这一轮不删。
                return false;
            }
            deleteDirectory(directory);
            return true;
        } catch (IOException | RuntimeException failure) {
            log.warn("删除会话上下文目录失败，留待下一轮: sessionId={}, error={}",
                    sessionId, failure.toString());
            return false;
        }
    }

    /** 目录里没有任何条目比 {@code idleBefore} 更新，就认为它已静止。 */
    private static boolean isIdleSince(Path directory, Instant idleBefore) throws IOException {
        Instant cutoff = idleBefore == null ? Instant.EPOCH : idleBefore;
        try (Stream<Path> entries = Files.list(directory)) {
            return entries.allMatch(entry -> {
                try {
                    return Files.getLastModifiedTime(entry, LinkOption.NOFOLLOW_LINKS).toInstant()
                            .isBefore(cutoff);
                } catch (IOException probeFailed) {
                    // 读不到时间就当作「不静止」：宁可不删，也不要删掉还在写的那份。
                    return false;
                }
            });
        }
    }

    private void publish(Path temp, Path target) throws IOException {
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException unsupported) {
            // 同一目录内理论上一定支持原子改名；退化路径只在异常文件系统上出现。
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void deleteDirectoryIfEmpty(long sessionId) throws IOException {
        Path directory = sessionDirectory(sessionId);
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> entries = Files.list(directory)) {
            // 非空直接跳过：绝不把「删空目录」写成「删有正文的目录」。
            if (entries.findAny().isPresent()) {
                return;
            }
        }
        Files.deleteIfExists(directory);
    }

    private void deleteDirectory(Path directory) throws IOException {
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> entries = Files.list(directory)) {
            for (Path entry : entries.toList()) {
                Files.deleteIfExists(entry);
            }
        }
        Files.deleteIfExists(directory);
    }

    /** 解析「库内引用」到真实路径，并复核仍在根目录内（防路径穿越与手改库）。 */
    private Path resolve(long sessionId, String bodyId) {
        if (bodyId == null || !BODY_ID.matcher(bodyId).matches()) {
            throw new IllegalStateException("非法的会话上下文标识: bodyId=" + bodyId);
        }
        Path directory = sessionDirectory(sessionId);
        Path candidate = directory.resolve(bodyId + SUFFIX).normalize();
        if (!candidate.startsWith(root)) {
            throw new IllegalStateException("非法的会话上下文标识: bodyId=" + bodyId);
        }
        return candidate;
    }

    private Path sessionDirectory(long sessionId) {
        String raw = Long.toString(sessionId);
        if (!SESSION_ID.matcher(raw).matches()) {
            throw new IllegalStateException("非法的会话标识: sessionId=" + sessionId);
        }
        Path directory = root.resolve(raw).normalize();
        if (!directory.startsWith(root)) {
            throw new IllegalStateException("非法的会话标识: sessionId=" + sessionId);
        }
        return directory;
    }

    private static void deleteQuietly(Path file) {
        if (file == null) {
            return;
        }
        try {
            Files.deleteIfExists(file);
        } catch (IOException ignored) {
            // 落盘已经失败，残留的 .part 是次要问题，不能掩盖原始异常。
        }
    }
}

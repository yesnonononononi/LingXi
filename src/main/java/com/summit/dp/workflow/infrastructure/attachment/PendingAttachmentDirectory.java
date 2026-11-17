package com.summit.dp.workflow.infrastructure.attachment;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.pending.PendingAttachmentStore;
import com.summit.dp.workflow.application.pending.PendingUpload;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 待发送附件的磁盘实现：{@code <dataDir>/pending-attachments/<sessionId>/<taskId>/<hash>.<ext>}。
 *
 * <p>为什么不复用 {@code images/}：那是工具生成图与读图工具的内容缓存，按会话整目录删，
 * 且只认 png/jpg + 16 位哈希命名；用户上传的 webp 放进去会被当外来文件留下，
 * 两个生命周期混在一个目录里迟早互相踩。</p>
 */
@Slf4j
@Component
public class PendingAttachmentDirectory implements PendingAttachmentStore {

    private static final Map<String, String> EXTENSIONS = Map.of(
            "image/png", "png",
            "image/jpeg", "jpg",
            "image/webp", "webp",
            "image/gif", "gif");
    private static final Set<String> KNOWN_EXTENSIONS = Set.of("png", "jpg", "webp", "gif");
    private static final Pattern ATTACHMENT_ID = Pattern.compile("^[0-9a-f]{16}$");
    private static final int SHORT_HASH_LENGTH = 16;

    private final Path root;

    public PendingAttachmentDirectory(@Value("${lingxi.data.dir}") String dataDir) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve("pending-attachments");
    }

    @Override
    public List<PendingAttachment> store(long sessionId, long taskId, List<PendingUpload> uploads) {
        if (uploads == null || uploads.isEmpty()) {
            return List.of();
        }
        long total = 0;
        for (PendingUpload upload : uploads) {
            total += upload.data() == null ? 0 : upload.data().length;
            if (extensionOf(upload.mime()) == null) {
                throw new ClientException("暂不支持的图片格式: " + upload.mime());
            }
        }
        if (total > MAX_TASK_BYTES) {
            throw new ClientException("待发送图片合计最多支持 12MB，请减少数量或压缩后重试");
        }
        if (usedBytes(sessionId) + total > MAX_SESSION_BYTES) {
            throw new ClientException("该会话排队的图片已占满 120MB，请先处理待发送消息");
        }

        Path directory = taskDirectory(sessionId, taskId);
        List<PendingAttachment> stored = new ArrayList<>(uploads.size());
        try {
            Files.createDirectories(directory);
            for (PendingUpload upload : uploads) {
                stored.add(write(directory, sessionId, taskId, upload));
            }
            return List.copyOf(stored);
        } catch (IOException failure) {
            // 半途失败不能留残缺任务：本次已写的文件全部撤掉，队列里也不会出现这行。
            deleteFiles(directory, stored.stream().map(PendingAttachment::id).toList());
            throw new ClientException("保存待发送图片失败，请重试");
        }
    }

    @Override
    public byte[] read(PendingAttachment attachment) {
        Path file = resolve(attachment.relPath());
        if (file == null) {
            throw new ClientException("待发送图片已丢失，请重新上传: " + attachment.name());
        }
        try {
            return Files.readAllBytes(file);
        } catch (IOException failure) {
            throw new ClientException("读取待发送图片失败: " + attachment.name());
        }
    }

    @Override
    public void deleteTask(long sessionId, long taskId) {
        try {
            deleteFiles(taskDirectory(sessionId, taskId), null);
        } catch (RuntimeException failure) {
            log.warn("删除待发送附件失败，留待后续清理: sessionId={}, taskId={}", sessionId, taskId, failure);
        }
    }

    @Override
    public void deleteSession(long sessionId) {
        Path directory = sessionDirectory(sessionId);
        try {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            try (Stream<Path> tasks = Files.list(directory)) {
                for (Path task : tasks.toList()) {
                    if (Files.isDirectory(task, LinkOption.NOFOLLOW_LINKS)) {
                        deleteFiles(task, null);
                    }
                }
            }
            Files.deleteIfExists(directory);
        } catch (IOException | RuntimeException failure) {
            log.warn("删除会话的待发送附件目录失败，留待后续清理: sessionId={}", sessionId, failure);
        }
    }

    @Override
    public void deleteAttachments(long sessionId, long taskId, Collection<String> attachmentIds) {
        if (attachmentIds == null || attachmentIds.isEmpty()) {
            return;
        }
        try {
            deleteFiles(taskDirectory(sessionId, taskId), attachmentIds);
        } catch (RuntimeException failure) {
            log.warn("删除被替换的待发送附件失败: sessionId={}, taskId={}", sessionId, taskId, failure);
        }
    }

    @Override
    public long usedBytes(long sessionId) {
        Path directory = sessionDirectory(sessionId);
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            return 0;
        }
        try (Stream<Path> tasks = Files.list(directory)) {
            long total = 0;
            for (Path task : tasks.toList()) {
                if (!Files.isDirectory(task, LinkOption.NOFOLLOW_LINKS)) {
                    continue;
                }
                try (Stream<Path> files = Files.list(task)) {
                    for (Path file : files.toList()) {
                        if (isOwnFile(file)) {
                            total += Files.size(file);
                        }
                    }
                }
            }
            return total;
        } catch (IOException failure) {
            // 读不到就当作「没有占用」会让预算形同虚设；按已用满处理，宁可拒绝入队。
            log.warn("统计待发送附件占用失败，按已满处理: sessionId={}", sessionId, failure);
            return MAX_SESSION_BYTES;
        }
    }

    private PendingAttachment write(Path directory, long sessionId, long taskId, PendingUpload upload)
            throws IOException {
        String extension = extensionOf(upload.mime());
        String id = shortHash(upload.data());
        String fileName = id + "." + extension;
        Path target = directory.resolve(fileName);
        if (!Files.exists(target)) {
            // 先写临时文件再改名：派发线程永远不该读到半截图。
            Path temporary = directory.resolve(fileName + ".tmp");
            Files.write(temporary, upload.data());
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
        }
        String relPath = sessionId + "/" + taskId + "/" + fileName;
        return new PendingAttachment(id, upload.name() == null ? fileName : upload.name(),
                upload.mime().toLowerCase(Locale.ROOT), upload.data().length, relPath);
    }

    /** 删除目录里本实现的产物；{@code attachmentIds} 为 null 表示整目录清空。 */
    private void deleteFiles(Path directory, Collection<String> attachmentIds) {
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (Stream<Path> children = Files.list(directory)) {
            for (Path child : children.toList()) {
                if (!Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS)) {
                    continue;
                }
                String name = child.getFileName().toString();
                if (name.endsWith(".tmp") || (isOwnFile(child) && matches(child, attachmentIds))) {
                    Files.deleteIfExists(child);
                }
            }
        } catch (IOException failure) {
            log.warn("删除待发送附件文件失败: directory={}", directory, failure);
        }
        try {
            Files.deleteIfExists(directory);
        } catch (DirectoryNotEmptyException foreignLeft) {
            log.warn("待发送附件目录里仍有非本实现的文件，未删除目录: directory={}", directory);
        } catch (IOException failure) {
            log.warn("删除待发送附件目录失败: directory={}", directory, failure);
        }
    }

    private boolean matches(Path file, Collection<String> attachmentIds) {
        if (attachmentIds == null) {
            return true;
        }
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String id = dot > 0 ? name.substring(0, dot) : name;
        return attachmentIds.contains(id);
    }

    /** relPath 来自库里，仍可能被改过或文件被外部搬走：解析后必须复核仍在根目录内。 */
    private Path resolve(String relPath) {
        if (relPath == null || relPath.isBlank()) {
            return null;
        }
        Path candidate = root.resolve(relPath).normalize();
        if (!candidate.startsWith(root) || !isOwnFile(candidate)) {
            return null;
        }
        try {
            if (!Files.isRegularFile(candidate)) {
                return null;
            }
            Path realRoot = root.toRealPath();
            Path realFile = candidate.toRealPath();
            return realFile.startsWith(realRoot) ? realFile : null;
        } catch (IOException missing) {
            return null;
        }
    }

    private static String extensionOf(String mime) {
        return mime == null ? null : EXTENSIONS.get(mime.trim().toLowerCase(Locale.ROOT));
    }

    private static boolean isOwnFile(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return false;
        }
        return ATTACHMENT_ID.matcher(name.substring(0, dot)).matches()
                && KNOWN_EXTENSIONS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    private static String shortHash(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(data == null ? new byte[0] : data))
                    .substring(0, SHORT_HASH_LENGTH);
        } catch (NoSuchAlgorithmException impossible) {
            throw new UncheckedIOException(new IOException("SHA-256 不可用", impossible));
        }
    }

    /** 会话目录只接受数字：它直接参与路径拼装，禁止任何上跳。 */
    private Path sessionDirectory(long sessionId) {
        return root.resolve(String.valueOf(sessionId));
    }

    private Path taskDirectory(long sessionId, long taskId) {
        return sessionDirectory(sessionId).resolve(String.valueOf(taskId));
    }
}

package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.dp.session.application.port.SessionImageCache;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 内容哈希避免重复落盘；缓存位于工作区之外，须由宿主读写。
 *
 * <p>目录按会话分：{@code images/<sessionId>/}。会话是本缓存的生命周期单位 —— 会话一删，
 * 目录里的哈希文件就再无任何引用，所以「删会话 → 删该会话目录」是不误伤其它会话的唯一判据。</p>
 */
@Slf4j
@Component
public class ImageCacheDirectory implements SessionImageCache {

    private static final Pattern IMAGE_ID = Pattern.compile("^[0-9a-f]{16}$");
    /** 会话标识只接受数字：它直接参与目录名，禁止任何路径分隔或上跳。 */
    private static final Pattern SESSION_ID = Pattern.compile("^[0-9]{1,19}$");
    private static final Set<String> EXTENSIONS = Set.of("png", "jpg");
    private static final int SHORT_HASH_LENGTH = 16;

    private final Path root;

    public ImageCacheDirectory(@Value("${lingxi.data.dir}") String dataDir) {
        this.root = Path.of(dataDir).toAbsolutePath().normalize().resolve("images");
    }

    /** 同内容复用缓存，避免同一执行反复读图时重复落盘。 */
    public CachedImage store(long sessionId, byte[] data, String extension) throws IOException {
        String imageId = shortHash(data);
        Path directory = directory(sessionId);
        Files.createDirectories(directory);
        Path file = directory.resolve(imageId + "." + extension);
        if (!Files.exists(file)) {
            Files.write(file, data);
        }
        return new CachedImage(imageId, file);
    }

    /** 注入时只认缓存标识与允许的扩展名，并复核真实路径仍在会话目录内。 */
    public Path resolve(long sessionId, String imageId, String extension) {
        if (imageId == null || !IMAGE_ID.matcher(imageId).matches()) return null;
        if (extension == null) return null;
        String normalizedExtension = extension.toLowerCase(Locale.ROOT);
        if (!EXTENSIONS.contains(normalizedExtension)) return null;
        Path directory = directory(sessionId);
        Path candidate = directory.resolve(imageId + "." + normalizedExtension).normalize();
        if (!candidate.startsWith(directory)) return null;
        try {
            if (!Files.isRegularFile(candidate)) return null;
            Path realDirectory = directory.toRealPath();
            Path realFile = candidate.toRealPath();
            return realFile.startsWith(realDirectory) ? realFile : null;
        } catch (IOException missing) {
            return null;
        }
    }

    /**
     * 删除这些会话的图片目录（会话行提交删除之后调用）。
     *
     * <p>只删本实现的产物（16 位十六进制哈希 + {@code .png}/{@code .jpg}）：用户或其它程序
     * 往这里放的东西不归清理管。删不掉只记录 —— 会话已经不存在，残留只是磁盘垃圾。</p>
     */
    @Override
    public void deleteSessions(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        for (Long sessionId : sessionIds) {
            if (sessionId == null) {
                continue;
            }
            Path directory = directory(sessionId);
            try {
                if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                    continue;
                }
                try (Stream<Path> children = Files.list(directory)) {
                    for (Path child : children.toList()) {
                        if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS) && isOwnFile(child)) {
                            Files.deleteIfExists(child);
                        }
                    }
                }
                Files.deleteIfExists(directory);
            } catch (DirectoryNotEmptyException foreignLeft) {
                log.warn("图片目录里仍有非本实现的文件，未删除目录: sessionId={}", sessionId);
            } catch (IOException | RuntimeException failure) {
                log.warn("删除会话图片目录失败，留待后续清理: sessionId={}, error={}",
                        sessionId, failure.toString());
            }
        }
    }

    /**
     * 列出已经在磁盘上留有图片目录的会话 id（只读目录名，不打开任何图片）。
     *
     * <p>孤儿清扫用它枚举候选：目录名不是数字的一律跳过 —— 那不是本实现的产物。</p>
     *
     * @param limit 单批上限
     */
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
            log.warn("枚举图片会话目录失败，跳过本轮: root={}, error={}", root, failure.toString());
            return List.of();
        }
    }

    /**
     * 删除这些会话的图片目录，但**只在目录已经静止时**（孤儿清扫用，不在会话删除路径上）。
     *
     * <p>静止判据与上下文正文同一条：目录里还有比 {@code idleBefore} 更新的文件，说明可能正有
     * 一次读图落盘在进行，这一轮跳过。</p>
     *
     * @param sessionIds 候选会话；目录不存在或不属于本实现的一律跳过
     * @param idleBefore 静止时间线（早于它才算静止）
     * @return 真正删掉的目录数
     */
    public int deleteIdleSessionDirectories(Collection<Long> sessionIds, Instant idleBefore) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return 0;
        }
        int deleted = 0;
        for (Long sessionId : sessionIds) {
            if (sessionId == null) {
                continue;
            }
            Path directory = directory(sessionId);
            try {
                if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                    continue;
                }
                if (!isIdleSince(directory, idleBefore)) {
                    continue;
                }
                try (Stream<Path> children = Files.list(directory)) {
                    for (Path child : children.toList()) {
                        if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS) && isOwnFile(child)) {
                            Files.deleteIfExists(child);
                        }
                    }
                }
                if (Files.deleteIfExists(directory)) {
                    deleted++;
                }
            } catch (DirectoryNotEmptyException foreignLeft) {
                log.warn("图片目录里仍有非本实现的文件，未删除目录: sessionId={}", sessionId);
            } catch (IOException | RuntimeException failure) {
                log.warn("清理无主图片目录失败，留待下一轮: sessionId={}, error={}",
                        sessionId, failure.toString());
            }
        }
        return deleted;
    }

    /** 目录里没有任何条目比 {@code idleBefore} 更新，就认为它已静止。 */
    private static boolean isIdleSince(Path directory, Instant idleBefore) throws IOException {
        Instant cutoff = idleBefore == null ? Instant.EPOCH : idleBefore;
        try (Stream<Path> children = Files.list(directory)) {
            return children.allMatch(child -> {
                try {
                    return Files.getLastModifiedTime(child, LinkOption.NOFOLLOW_LINKS).toInstant()
                            .isBefore(cutoff);
                } catch (IOException probeFailed) {
                    // 读不到时间就当作「不静止」：宁可不删，也不要删掉正在写的那张图。
                    return false;
                }
            });
        }
    }

    /** 本实现的产物只有 {@code <16 位十六进制>.<png|jpg>}。 */
    private static boolean isOwnFile(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return false;
        }
        return IMAGE_ID.matcher(name.substring(0, dot)).matches()
                && EXTENSIONS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    private Path directory(long sessionId) {
        return root.resolve(String.valueOf(sessionId));
    }

    private String shortHash(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(data)).substring(0, SHORT_HASH_LENGTH);
        } catch (NoSuchAlgorithmException impossible) {
            throw new UncheckedIOException(new IOException("SHA-256 不可用", impossible));
        }
    }

    /** 缓存结果：{@code imageId} 即内容哈希前 16 位。 */
    public record CachedImage(String imageId, Path path) {
    }
}

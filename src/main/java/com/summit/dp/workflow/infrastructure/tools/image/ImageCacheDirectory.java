package com.summit.dp.workflow.infrastructure.tools.image;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** 内容哈希避免重复落盘；缓存位于工作区之外，须由宿主读写。 */
@Component
public class ImageCacheDirectory {

    private static final Pattern IMAGE_ID = Pattern.compile("^[0-9a-f]{16}$");
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

        /** 落盘字节数；读不到按 0 处理（回执里只是给人看的参考值）。 */
        public long bytes() {
            try {
                return Files.size(path);
            } catch (IOException missing) {
                return 0L;
            }
        }
    }
}

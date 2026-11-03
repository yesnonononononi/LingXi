package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.stream.Stream;

/** 目录在进程内按项目复用，避免每次构建提示词或调用工具时重新扫描。 */
@Component
public class MemoryWikiIndexCache {
    private final ConcurrentMap<Path, Index> indexes = new ConcurrentHashMap<>();

    public Index load(Path projectRoot, Path directory) throws IOException {
        try {
            return indexes.computeIfAbsent(directory, key -> {
                try {
                    return scan(projectRoot, key);
                } catch (IOException error) {
                    throw new UncheckedIOException(error);
                }
            });
        } catch (UncheckedIOException error) {
            // 失败不入缓存，目录恢复后允许下一次读取重试。
            throw error.getCause();
        }
    }

    private Index scan(Path projectRoot, Path directory) throws IOException {
        if (!Files.exists(directory)) return new Index(directory, Map.of());
        throwIf(!Files.isDirectory(directory), "记忆 wiki 目录配置指向了文件，请配置目录路径");
        Path realProjectRoot = projectRoot.toRealPath();
        Path realDirectory = directory.toRealPath();
        throwIf(!realDirectory.startsWith(realProjectRoot) || realDirectory.equals(realProjectRoot),
                "记忆 wiki 目录不能指向项目工作目录外部");

        Map<String, Path> loaded = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(realDirectory)) {
            // 不跟随符号链接，子目录相同文件名仍以相对路径区分。
            walk.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .filter(path -> path.getFileName().toString().endsWith(".md"))
                    .sorted()
                    .forEach(path -> loaded.put(realDirectory.relativize(path).toString().replace('\\', '/'), path));
        }
        return new Index(realDirectory, loaded);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    /** 只缓存索引，正文始终经本次工作空间桥接读取，不能共享权限。 */
    public record Index(Path root, Map<String, Path> wikis) {
        public Index {
            wikis = Map.copyOf(wikis);
        }
    }
}

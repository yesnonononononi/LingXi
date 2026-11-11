package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 会话级文件资源的删除边界：删得掉自己的产物，也删不动不该碰的东西。
 *
 * <p>三个目录各有一套「哪些文件算我的」判据，弄错一次就是删用户的图或删正在写的正文。
 * 这里在真实文件系统上验证，不用内存假件。</p>
 */
class SessionAssetCleanupTest {

    @TempDir
    Path dataDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();

    @Test
    void imageCacheDeletionOnlyRemovesOwnFilesThenTheDirectory() throws IOException {
        ImageCacheDirectory images = new ImageCacheDirectory(dataDir.toString());
        byte[] png = new byte[]{1, 2, 3};
        images.store(42L, png, "png");
        Path directory = dataDir.resolve("images").resolve("42");
        // 用户往缓存目录里丢的东西不归清理管。
        Path foreign = Files.writeString(directory.resolve("notes.txt"), "用户自己放的");

        images.deleteSessions(List.of(42L));

        assertTrue(Files.isRegularFile(foreign), "非本实现的文件不得删除");
        try (var entries = Files.list(directory)) {
            assertEquals(List.of("notes.txt"), entries.map(path -> path.getFileName().toString()).toList(),
                    "本实现的图片必须被删掉");
        }
    }

    @Test
    void imageCacheKeepsOtherSessionsUntouched() throws IOException {
        ImageCacheDirectory images = new ImageCacheDirectory(dataDir.toString());
        images.store(42L, new byte[]{1}, "png");
        images.store(43L, new byte[]{2}, "png");

        images.deleteSessions(List.of(42L));

        assertTrue(Files.isDirectory(dataDir.resolve("images").resolve("43")), "其它会话的图片目录不得删除");
    }

    /** 还没静止的目录（可能有一次落盘正在进行）这一轮必须跳过。 */
    @Test
    void idleImageDeletionSkipsDirectoriesWrittenToRecently() throws IOException {
        ImageCacheDirectory images = new ImageCacheDirectory(dataDir.toString());
        images.store(42L, new byte[]{1}, "png");
        Instant idleBefore = Instant.now().minus(10, ChronoUnit.MINUTES);

        assertEquals(0, images.deleteIdleSessionDirectories(List.of(42L), idleBefore),
                "新写的目录不能当无主目录删掉");
        assertTrue(Files.isDirectory(dataDir.resolve("images").resolve("42")));

        // 把文件时间推到很久以前，同一调用就应该删得掉。
        Path file = Files.list(dataDir.resolve("images").resolve("42")).findFirst().orElseThrow();
        Files.setLastModifiedTime(file, FileTime.from(Instant.now().minus(1, ChronoUnit.DAYS)));
        assertEquals(1, images.deleteIdleSessionDirectories(List.of(42L), idleBefore));
        assertFalse(Files.exists(dataDir.resolve("images").resolve("42")));
    }

    @Test
    void checkpointDirectoryIsRemovedWithItsFiles() throws IOException {
        LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper, 0L);
        var writer = store.begin("900");
        mapper.writeValue(writer.stream(), java.util.Map.of("id", "900"));
        writer.publish();
        writer.complete();
        Path directory = dataDir.resolve("checkpoints").resolve("900");
        assertTrue(Files.isRegularFile(directory.resolve(writer.fileId() + ".json")));

        assertTrue(store.deleteExecutionDirectory("900"));

        assertFalse(Files.exists(directory), "执行行已删除，整个检查点目录都要带走");
    }

    /** 还有写入没定论时整轮跳过：那是线程马上要发布的那一份。 */
    @Test
    void checkpointDirectoryIsKeptWhileAWriteIsInFlight() throws IOException {
        LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper, 0L);
        var writer = store.begin("901");
        mapper.writeValue(writer.stream(), java.util.Map.of("id", "901"));
        writer.publish();
        try {
            assertFalse(store.deleteExecutionDirectory("901"), "在途写入的执行目录不得删除");
            assertTrue(Files.isDirectory(dataDir.resolve("checkpoints").resolve("901")));
        } finally {
            writer.complete();
        }
    }

    @Test
    void contextSessionDirectoryIsRemovedOnlyWhenIdle() throws IOException {
        LocalSessionContextFileStore store = new LocalSessionContextFileStore(dataDir.toString(), mapper);
        store.write(77L, List.of());
        Path directory = dataDir.resolve("session-context").resolve("77");
        assertTrue(Files.isDirectory(directory));

        assertFalse(store.deleteSessionDirectory(77L, Instant.now().minus(10, ChronoUnit.MINUTES)),
                "刚写过的目录不能删");

        assertEquals(List.of(77L), store.listSessionIds(10));
        assertTrue(store.deleteSessionDirectory(77L, Instant.now().plus(1, ChronoUnit.MINUTES)));
        assertFalse(Files.exists(directory));
    }
}

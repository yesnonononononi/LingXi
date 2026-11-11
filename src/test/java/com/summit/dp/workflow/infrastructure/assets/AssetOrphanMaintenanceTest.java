package com.summit.dp.workflow.infrastructure.assets;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.AssetOrphanMaintenance.OrphanPreview;
import com.summit.dp.execution.application.port.AssetOrphanMaintenance.OrphanReclaimResult;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 孤儿清扫的判据只有「会话还在不在」。
 *
 * <p>两个方向都要证明：会话没了就要清干净（否则盘上永远多两个目录），
 * 会话还在就一根汗毛都不能动（否则会删掉「已落盘、尚未换引用」的正文）。</p>
 */
class AssetOrphanMaintenanceTest {

    @TempDir
    Path dataDir;

    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private SessionRepository sessions;
    private LocalSessionContextFileStore contexts;
    private ImageCacheDirectory images;
    private LocalAssetOrphanMaintenance sweeper;

    /** 目录注入发生在构造之后：这里现场装配，字段初始化器拿不到 {@code dataDir}。 */
    @org.junit.jupiter.api.BeforeEach
    void setup() {
        sessions = mock(SessionRepository.class);
        contexts = new LocalSessionContextFileStore(dataDir.toString(), mapper);
        images = new ImageCacheDirectory(dataDir.toString());
        sweeper = new LocalAssetOrphanMaintenance(sessions, contexts, images);
    }

    @Test
    void removesContextAndImageDirectoriesOfDeletedSessions() throws IOException {
        seed(77L);
        when(sessions.findExistingIds(any())).thenReturn(List.of());

        OrphanPreview preview = sweeper.preview(50);
        assertEquals(1, preview.orphanSessionDirs(), "预览必须报出无主目录");
        assertTrue(preview.mayHaveMore(50));

        OrphanReclaimResult result = sweeper.reclaim(50, future());

        assertEquals(1, result.deletedContextDirs());
        assertEquals(1, result.deletedImageDirs());
        assertEquals(0, result.skippedActiveDirs());
        assertFalse(Files.exists(dataDir.resolve("session-context").resolve("77")));
        assertFalse(Files.exists(dataDir.resolve("images").resolve("77")));
    }

    @Test
    void keepsEverythingOfLiveSessions() throws IOException {
        seed(77L);
        when(sessions.findExistingIds(any())).thenReturn(List.of(77L));

        assertEquals(0, sweeper.preview(50).orphanSessionDirs());
        OrphanReclaimResult result = sweeper.reclaim(50, future());

        assertEquals(0, result.deletedContextDirs());
        assertEquals(0, result.deletedImageDirs());
        assertTrue(Files.isDirectory(dataDir.resolve("session-context").resolve("77")));
        assertTrue(Files.isDirectory(dataDir.resolve("images").resolve("77")));
    }

    /** 会话没了但目录刚被写过：可能还有一次落盘在飞，这一轮必须放过。 */
    @Test
    void skipsOrphanDirectoriesThatAreStillBeingWritten() throws IOException {
        seed(77L);
        when(sessions.findExistingIds(any())).thenReturn(List.of());

        OrphanReclaimResult result = sweeper.reclaim(50, Instant.now().minus(10, ChronoUnit.MINUTES));

        assertEquals(0, result.deletedContextDirs());
        assertEquals(2, result.skippedActiveDirs(), "两个目录都应记为跳过");
        assertTrue(Files.isDirectory(dataDir.resolve("session-context").resolve("77")));
        assertTrue(Files.isDirectory(dataDir.resolve("images").resolve("77")));
    }

    @Test
    void noDirectoriesMeansNoQueries() {
        OrphanReclaimResult result = sweeper.reclaim(50, future());

        assertEquals(0, result.deletedContextDirs() + result.deletedImageDirs());
        org.mockito.Mockito.verify(sessions, org.mockito.Mockito.never()).findExistingIds(any());
    }

    private void seed(long sessionId) throws IOException {
        contexts.write(sessionId, List.of());
        images.store(sessionId, new byte[]{1, 2, 3}, "png");
    }

    /** 静止线放到未来：等价于「目录早就没人碰了」。 */
    private static Instant future() {
        return Instant.now().plus(1, ChronoUnit.MINUTES);
    }
}

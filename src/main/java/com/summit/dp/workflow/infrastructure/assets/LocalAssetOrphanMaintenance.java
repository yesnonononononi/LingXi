package com.summit.dp.workflow.infrastructure.assets;

import com.summit.dp.execution.application.port.AssetOrphanMaintenance;
import com.summit.dp.session.application.port.SessionContextStore;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 数据目录孤儿清扫的本机实现：会话上下文正文与图片目录。
 *
 * <p>判据只有一条 —— **会话行还在不在**。这两类目录都按会话分，会话一删，目录里的东西就再没有
 * 任何读者；反过来，会话还在就绝不按「这个文件没被引用」去猜：正文替换存在「已落盘、尚未换引用」
 * 的窗口，猜错一次就是「库内引用指向不存在的文件」。</p>
 *
 * <p>因此这里不做引用比对，只做两件事：存在性判定 + 静止判定。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class LocalAssetOrphanMaintenance implements AssetOrphanMaintenance {

    private final SessionRepository sessions;
    private final SessionContextStore contexts;
    private final ImageCacheDirectory images;

    @Override
    public OrphanPreview preview(int maxSessions) {
        int limit = Math.max(maxSessions, 1);
        List<Long> contextIds = contexts.listSessionIds(limit);
        List<Long> imageIds = images.listSessionIds(limit);
        Set<Long> candidates = new LinkedHashSet<>(contextIds);
        candidates.addAll(imageIds);
        int orphans = countOrphans(candidates);
        return new OrphanPreview(contextIds.size(), imageIds.size(), orphans);
    }

    @Override
    public OrphanReclaimResult reclaim(int maxSessions, Instant idleBefore) {
        int limit = Math.max(maxSessions, 1);
        List<Long> contextIds = contexts.listSessionIds(limit);
        List<Long> imageIds = images.listSessionIds(limit);
        Set<Long> candidates = new LinkedHashSet<>(contextIds);
        candidates.addAll(imageIds);
        if (candidates.isEmpty()) {
            return new OrphanReclaimResult(0, 0, 0);
        }
        Set<Long> existing = new LinkedHashSet<>(sessions.findExistingIds(candidates));
        List<Long> orphanContexts = contextIds.stream().filter(id -> !existing.contains(id)).toList();
        List<Long> orphanImages = imageIds.stream().filter(id -> !existing.contains(id)).toList();

        int deletedContextDirs = 0;
        for (Long sessionId : orphanContexts) {
            if (contexts.deleteSessionDirectory(sessionId, idleBefore)) {
                deletedContextDirs++;
            }
        }
        int deletedImageDirs = images.deleteIdleSessionDirectories(orphanImages, idleBefore);
        int skipped = orphanContexts.size() - deletedContextDirs + orphanImages.size() - deletedImageDirs;
        if (deletedContextDirs > 0 || deletedImageDirs > 0 || skipped > 0) {
            log.info("清扫无主会话文件: deletedContextDirs={}, deletedImageDirs={}, skippedActiveDirs={}",
                    deletedContextDirs, deletedImageDirs, skipped);
        }
        return new OrphanReclaimResult(deletedContextDirs, deletedImageDirs, skipped);
    }

    /** 一次 {@code IN} 查询算出「目录还在、会话没了」的数量。 */
    private int countOrphans(Set<Long> candidates) {
        if (candidates.isEmpty()) {
            return 0;
        }
        Set<Long> existing = new LinkedHashSet<>(sessions.findExistingIds(candidates));
        return (int) candidates.stream().filter(id -> !existing.contains(id)).count();
    }
}

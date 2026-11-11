package com.summit.dp.execution.support;

import com.summit.dp.execution.application.port.AssetOrphanMaintenance;

import java.time.Instant;

/**
 * 「没有会话级孤儿目录」的清扫端口替身。
 *
 * <p>多条清理用例只关心执行行与检查点文件；会话上下文 / 图片目录的边界由
 * {@code AssetOrphanMaintenanceTest} 单独验证。有了它，这些用例不必各自实现两个方法。</p>
 */
public class NoAssetOrphans implements AssetOrphanMaintenance {

    @Override
    public OrphanPreview preview(int maxSessions) {
        return new OrphanPreview(0, 0, 0);
    }

    @Override
    public OrphanReclaimResult reclaim(int maxSessions, Instant idleBefore) {
        return new OrphanReclaimResult(0, 0, 0);
    }
}

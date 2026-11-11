package com.summit.dp.execution.application.port;

/**
 * 数据目录里「会话级文件资源」的孤儿清扫端口。
 *
 * <p><b>为什么不并进检查点回收</b>：检查点的引用在 {@code execution.snapshot_file} 上，可以逐个文件比对；
 * 会话上下文正文与图片目录的引用在「会话行是否存在」上，判据与扫描范围完全不同。
 * 两者都由同一个清理入口触发，但实现各自独立。</p>
 *
 * <p><b>安全边界只有一条</b>：只动**会话已不存在**的目录。未删会话的上下文正文与图片可能有
 * 一次「已落盘、尚未换引用」的窗口，删它就会造出「库内引用指向不存在文件」的损坏。</p>
 */
public interface AssetOrphanMaintenance {

    /**
     * 预览：枚举一批会话级目录，报出其中的无主数量。
     *
     * <p>只做有界枚举（最多 {@code maxSessions} 个目录），报的是「至少这么多」，
     * 与清理入口的分批语义一致。</p>
     *
     * @param maxSessions 单批枚举上限
     */
    OrphanPreview preview(int maxSessions);

    /**
     * 清扫：删掉无主的会话上下文目录与图片目录。
     *
     * <p>目录内还有比 {@code idleBefore} 更新的文件就整体跳过 —— 那是「可能正在写」的信号。</p>
     *
     * @param maxSessions 单批枚举上限
     * @param idleBefore  静止时间线（早于它才算静止）
     */
    OrphanReclaimResult reclaim(int maxSessions, java.time.Instant idleBefore);

    /**
     * 预览结果。
     *
     * @param contextSessionDirs 有正文目录的会话数（本批枚举到的）
     * @param imageSessionDirs   有图片目录的会话数（本批枚举到的）
     * @param orphanSessionDirs  其中会话已经不存在的数量
     */
    record OrphanPreview(int contextSessionDirs, int imageSessionDirs, int orphanSessionDirs) {

        /** 是否还有可能要清理：预览数量达到单批上限，说明后面还有没枚举到的目录。 */
        public boolean mayHaveMore(int maxSessions) {
            return orphanSessionDirs > 0 || contextSessionDirs >= maxSessions || imageSessionDirs >= maxSessions;
        }
    }

    /** 清扫结果：删掉的上下文目录数、图片目录数，以及因为还在写而跳过的目录数。 */
    record OrphanReclaimResult(int deletedContextDirs, int deletedImageDirs, int skippedActiveDirs) { }
}

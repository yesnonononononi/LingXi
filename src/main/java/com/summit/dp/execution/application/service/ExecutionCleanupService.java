package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.AssetOrphanMaintenance;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * 历史快照承担重发基线，只有失去业务引用的终态执行可以回收。
 *
 * <p>同一个手动清理入口顺带回收检查点正文文件：先按执行逐条提交数据库删除（提交后才删该行的
 * 正文文件），再按批扫一遍 {@code checkpoints} 根目录，收掉删文件失败留下的旧文件、
 * 行已消失的孤儿文件和未完成的临时文件。清全文文件不读正文，也不碰数据目录里的其它内容。</p>
 *
 * <p>执行行一旦删掉，它名下的文件编辑记录也一起走：{@code file_record} 只按 {@code execution_id}
 * 归属，行没了就再也认不回来；只等 15 天 TTL 会让基线目录白占磁盘。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExecutionCleanupService {
    private static final int BATCH_SIZE = 200;
    private static final int MAX_BATCHES = 50;
    /** 文件编辑记录的保留期：过期后连同落盘的基线大文本一起回收。 */
    private static final Duration FILE_RECORD_RETENTION = Duration.ofDays(15);
    /** 单次清理最多扫多少个执行目录 / 每个目录最多处理多少个文件。 */
    private static final int MAX_FILE_DIRECTORIES = 400;
    private static final int MAX_FILES_PER_EXECUTION = 50;
    /** 单次清理最多枚举多少个会话级目录（上下文正文 / 图片）。 */
    private static final int MAX_SESSION_DIRECTORIES = 400;
    /**
     * 会话级目录的静止期：比这更近被写过的目录本轮跳过。
     *
     * <p>存在的意义是避开「正文已落盘、引用还没提交」的窗口 —— 那个窗口里文件看起来像无主垃圾，
     * 删掉就是数据损坏。等一轮的成本只是晚几分钟回收。</p>
     */
    private static final Duration SESSION_DIRECTORY_IDLE_PERIOD = Duration.ofMinutes(10);
    private final ExecutionRepository repository;
    private final ExecutionReclaimService reclaimer;
    private final ExecutionCheckpointMaintenance checkpoints;
    /** 过期的文件编辑记录（连同基线大文本）与检查点一起在这里回收。 */
    private final FileRecordMaintenance fileRecords;
    /** 会话级文件资源（上下文正文 / 图片目录）的孤儿清扫。 */
    private final AssetOrphanMaintenance orphanAssets;

    /**
     * 清理预览：把「可回收的数据库行」、「文件侧是否还要扫描」与「过期文件编辑记录」分开报。
     *
     * <p>只报行数是不够的：孤儿 JSON、{@code .part} 残留、以及上一轮目录预算之后还没扫到的文件
     * 都不会体现在行数里；过期的文件编辑记录更是与执行行完全无关的另一类删除。
     * 清理既然会删它们，预览就必须先说出来 —— 否则界面会出现「预览说没啥可清、点一下却删了东西」。</p>
     */
    public Preview preview() {
        AssetOrphanMaintenance.OrphanPreview orphans = orphanAssets.preview(MAX_SESSION_DIRECTORIES);
        return new Preview(repository.countReclaimable(), checkpoints.hasUnscannedFiles(),
                fileRecords.countBefore(fileRecordCutoff()), orphans.orphanSessionDirs(),
                orphans.mayHaveMore(MAX_SESSION_DIRECTORIES));
    }

    // 查询也必须脱离调用方事务，避免清理后的计数仍命中旧的会话缓存。
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public CleanupResult cleanup() {
        long deleted = 0;
        long cascadedRecords = 0;
        long afterId = 0;
        // 只限制本次请求的扫描量，每条快照独立提交，避免累积大体积回滚日志。
        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            List<Execution> candidates = repository.findReclaimable(afterId, BATCH_SIZE);
            for (Execution candidate : candidates) {
                afterId = candidate.getId();
                if (!reclaimer.reclaim(candidate)) {
                    continue;
                }
                deleted++;
                // 行已提交删除，它名下的编辑记录同时失去归属：只等 15 天 TTL 会让基线目录白占磁盘。
                cascadedRecords += fileRecords.deleteByExecutionIds(List.of(String.valueOf(candidate.getId())));
            }
            if (candidates.size() < BATCH_SIZE) break;
        }
        // 行删完之后再收文件：此时「无引用」的判定是最终状态，不会误删刚被其他路径保留的正文。
        ExecutionCheckpointMaintenance.FileReclaimResult files =
                checkpoints.reclaimUnreferenced(MAX_FILE_DIRECTORIES, MAX_FILES_PER_EXECUTION);
        long remaining = repository.countReclaimable();
        // 会话级文件资源：只清「会话已经不存在」的目录，未删会话的东西一概不碰。
        AssetOrphanMaintenance.OrphanReclaimResult orphans =
                orphanAssets.reclaim(MAX_SESSION_DIRECTORIES, Instant.now().minus(SESSION_DIRECTORY_IDLE_PERIOD));
        // 文件编辑记录按时间淘汰：与检查点无关，即使没有可回收的执行也会顺手清掉过期记录。
        int purgedRecords = fileRecords.purgeBefore(fileRecordCutoff());
        log.info("清理无用执行数据: deletedCount={}, remainingCount={}, deletedFiles={},"
                        + " skippedInFlightFiles={}, deletedDirectories={}, purgedFileRecords={},"
                        + " cascadedFileRecords={}, deletedContextDirs={}, deletedImageDirs={},"
                        + " skippedActiveSessionDirs={}",
                deleted, remaining, files.deletedFiles(), files.skippedInFlight(), files.deletedDirectories(),
                purgedRecords, cascadedRecords, orphans.deletedContextDirs(), orphans.deletedImageDirs(),
                orphans.skippedActiveDirs());
        return new CleanupResult(deleted, remaining);
    }

    /** 文件编辑记录的过期水位：预览与清理必须用同一口径，否则预览数字和实删对不上。 */
    private static Instant fileRecordCutoff() {
        return Instant.now().minus(FILE_RECORD_RETENTION);
    }

    /**
     * 预览结果。
     *
     * @param executionCount 可回收的数据库行数
     * @param filesNeedScan  文件侧是否还有要扫描的内容（孤儿 JSON / {@code .part} / 未扫到的目录）
     * @param expiredFileRecordCount 过期的文件编辑记录条数（连同落盘基线会被一并回收）
     * @param orphanSessionDirCount 无主的会话级目录数（上下文正文 / 图片，会话已不存在）
     * @param sessionDirsMayHaveMore 会话级目录是否还有没枚举到的（触发条件与文件侧一致）
     */
    public record Preview(long executionCount, boolean filesNeedScan, long expiredFileRecordCount,
                          int orphanSessionDirCount, boolean sessionDirsMayHaveMore) { }
    public record CleanupResult(long deletedCount, long remainingCount) { }
}

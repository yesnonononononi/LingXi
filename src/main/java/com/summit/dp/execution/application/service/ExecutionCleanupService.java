package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 历史快照承担重发基线，只有失去业务引用的终态执行可以回收。
 *
 * <p>同一个手动清理入口顺带回收检查点正文文件：先按执行逐条提交数据库删除（提交后才删该行的
 * 正文文件），再按批扫一遍 {@code checkpoints} 根目录，收掉删文件失败留下的旧文件、
 * 行已消失的孤儿文件和未完成的临时文件。清全文文件不读正文，也不碰数据目录里的其它内容。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExecutionCleanupService {
    private static final int BATCH_SIZE = 200;
    private static final int MAX_BATCHES = 50;
    /**
     * 文件编辑记录的保留期：过期后连同落盘的基线大文本一起回收。
     *
     * <p>基线的价值只在「一段时间内还想看这轮改了什么」，而它是这条链路里唯一的超大字段；
     * 15 天后仍在库里就是纯占盘。回收整条记录而不是只删基线，理由见
     * {@link com.summit.dp.execution.application.port.FileRecordMaintenance}。</p>
     */
    private static final java.time.Duration FILE_RECORD_RETENTION = java.time.Duration.ofDays(15);
    /** 单次清理最多扫多少个执行目录 / 每个目录最多处理多少个文件。 */
    private static final int MAX_FILE_DIRECTORIES = 400;
    private static final int MAX_FILES_PER_EXECUTION = 50;
    private final ExecutionRepository repository;
    private final ExecutionReclaimService reclaimer;
    private final ExecutionCheckpointMaintenance checkpoints;
    /** 过期的文件编辑记录（连同基线大文本）与检查点一起在这里回收。 */
    private final FileRecordMaintenance fileRecords;

    /**
     * 清理预览：把「可回收的数据库行」与「文件侧是否还要扫描」分开报。
     *
     * <p>只报行数是不够的：孤儿 JSON、{@code .part} 残留、以及上一轮目录预算之后还没扫到的文件
     * 都不会体现在行数里。行数为 0 但文件侧还有东西时，界面必须仍然允许触发清理 ——
     * 否则这些垃圾永远轮不到回收，跨调用游标也就推不动。</p>
     */
    public Preview preview() {
        return new Preview(repository.countReclaimable(), checkpoints.hasUnscannedFiles());
    }

    // 查询也必须脱离调用方事务，避免清理后的计数仍命中旧的会话缓存。
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public CleanupResult cleanup() {
        long deleted = 0;
        long afterId = 0;
        // 只限制本次请求的扫描量，每条快照独立提交，避免累积大体积回滚日志。
        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            List<Execution> candidates = repository.findReclaimable(afterId, BATCH_SIZE);
            for (Execution candidate : candidates) {
                afterId = candidate.getId();
                if (reclaimer.reclaim(candidate)) {
                    deleted++;
                }
            }
            if (candidates.size() < BATCH_SIZE) break;
        }
        // 行删完之后再收文件：此时「无引用」的判定是最终状态，不会误删刚被其他路径保留的正文。
        ExecutionCheckpointMaintenance.FileReclaimResult files =
                checkpoints.reclaimUnreferenced(MAX_FILE_DIRECTORIES, MAX_FILES_PER_EXECUTION);
        long remaining = repository.countReclaimable();
        // 文件编辑记录按时间淘汰：与检查点无关，即使没有可回收的执行也会顺手清掉过期记录。
        int purgedRecords = fileRecords.purgeBefore(java.time.Instant.now().minus(FILE_RECORD_RETENTION));
        log.info("清理无用执行数据: deletedCount={}, remainingCount={}, deletedFiles={},"
                        + " skippedInFlightFiles={}, deletedDirectories={}, purgedFileRecords={}",
                deleted, remaining, files.deletedFiles(), files.skippedInFlight(), files.deletedDirectories(),
                purgedRecords);
        return new CleanupResult(deleted, remaining);
    }

    /**
     * 预览结果。
     *
     * @param executionCount 可回收的数据库行数
     * @param filesNeedScan  文件侧是否还有要扫描的内容（孤儿 JSON / {@code .part} / 未扫到的目录）
     */
    public record Preview(long executionCount, boolean filesNeedScan) { }
    public record CleanupResult(long deletedCount, long remainingCount) { }
}

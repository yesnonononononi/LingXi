package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
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
    /** 单次清理最多扫多少个执行目录 / 每个目录最多处理多少个文件。 */
    private static final int MAX_FILE_DIRECTORIES = 400;
    private static final int MAX_FILES_PER_EXECUTION = 50;
    private final ExecutionRepository repository;
    private final ExecutionReclaimService reclaimer;
    private final ExecutionCheckpointMaintenance checkpoints;

    public Preview preview() {
        return new Preview(repository.countReclaimable());
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
        log.info("清理无用执行数据: deletedCount={}, remainingCount={}, deletedFiles={}, skippedInFlightFiles={}",
                deleted, remaining, files.deletedFiles(), files.skippedInFlight());
        return new CleanupResult(deleted, remaining);
    }

    public record Preview(long executionCount) { }
    public record CleanupResult(long deletedCount, long remainingCount) { }
}

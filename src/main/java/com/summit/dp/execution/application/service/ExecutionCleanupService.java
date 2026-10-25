package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/** 历史快照承担重发基线，只有失去业务引用的终态执行可以回收。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExecutionCleanupService {
    private static final int BATCH_SIZE = 200;
    private static final int MAX_BATCHES = 50;
    private final ExecutionRepository repository;
    private final ExecutionActivity activity;

    public Preview preview() {
        return new Preview(repository.countReclaimable());
    }

    @Transactional
    public CleanupResult cleanup() {
        long deleted = 0;
        long afterId = 0;
        // 限制单次事务的扫描量，剩余记录由界面展示，避免长时间持有数据库锁。
        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            List<Execution> candidates = repository.findReclaimable(afterId, BATCH_SIZE);
            for (Execution candidate : candidates) {
                afterId = candidate.getId();
                // 终态落库可能早于控制槽位释放；这段窗口仍由执行线程负责收尾。
                if (!activity.isActive(String.valueOf(candidate.getId()))
                        && repository.deleteReclaimable(candidate.getId(), candidate.getVersion())) {
                    deleted++;
                }
            }
            if (candidates.size() < BATCH_SIZE) break;
        }
        long remaining = repository.countReclaimable();
        log.info("清理无用执行数据: deletedCount={}, remainingCount={}", deleted, remaining);
        return new CleanupResult(deleted, remaining);
    }

    public record Preview(long executionCount) { }
    public record CleanupResult(long deletedCount, long remainingCount) { }
}

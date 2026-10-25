package com.summit.dp.execution.application.service;

import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
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
    private final ExecutionReclaimService reclaimer;

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
        long remaining = repository.countReclaimable();
        log.info("清理无用执行数据: deletedCount={}, remainingCount={}", deleted, remaining);
        return new CleanupResult(deleted, remaining);
    }

    public record Preview(long executionCount) { }
    public record CleanupResult(long deletedCount, long remainingCount) { }
}

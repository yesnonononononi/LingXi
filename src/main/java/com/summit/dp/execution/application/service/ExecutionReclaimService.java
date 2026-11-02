package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 每条快照独立回收：先提交数据库删除，再删对应检查点文件。
 *
 * <p><b>顺序不能反</b>：库先行是唯一权威。反过来先删文件再删行，一旦删行失败，
 * 库里就留下一条「指向不存在正文」的执行，恢复/重发会直接读空。现在的最坏情况是
 * 「行没了、文件还在」，那只是垃圾文件，由清理入口的孤儿回收兜底。</p>
 */
@Service
@Slf4j
public class ExecutionReclaimService {
    private final ExecutionRepository repository;
    private final ExecutionActivity activity;
    private final ExecutionCheckpointMaintenance checkpoints;
    private final TransactionTemplate transactions;

    public ExecutionReclaimService(ExecutionRepository repository, ExecutionActivity activity,
                                   ExecutionCheckpointMaintenance checkpoints,
                                   PlatformTransactionManager transactionManager) {
        this.repository = repository;
        this.activity = activity;
        this.checkpoints = checkpoints;
        this.transactions = new TransactionTemplate(transactionManager);
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * 回收一条已结束且无业务引用的执行。
     *
     * @return 是否真的删掉了数据库行（文件删除失败不影响这个结果）
     */
    public boolean reclaim(Execution execution) {
        String executionId = Long.toString(execution.getId());
        // 先按条件删除再检查结果，避免查询结果与实际删除之间被并发写入改变。
        String replacedFile = repository.findCheckpointSummary(execution.getId())
                .map(Execution::getSnapshotFile)
                .orElse(null);
        boolean deleted = Boolean.TRUE.equals(transactions.execute(status -> {
            // 终态落库可能早于控制槽位释放，这段窗口仍由执行线程负责收尾。
            if (activity.isActive(executionId)) return false;
            return repository.deleteReclaimable(execution.getId(), execution.getVersion());
        }));
        if (!deleted) {
            return false;
        }
        // 事务已提交：现在才动文件。与读取按 executionId 互斥，删不掉只是垃圾。
        checkpoints.deleteFile(executionId, replacedFile);
        return true;
    }
}

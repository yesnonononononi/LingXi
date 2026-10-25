package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** 每条快照独立回收，避免 H2 在长事务中积累快照正文的回滚副本。 */
@Service
public class ExecutionReclaimService {
    private final ExecutionRepository repository;
    private final ExecutionActivity activity;
    private final TransactionTemplate transactions;

    public ExecutionReclaimService(ExecutionRepository repository, ExecutionActivity activity,
                                   PlatformTransactionManager transactionManager) {
        this.repository = repository;
        this.activity = activity;
        this.transactions = new TransactionTemplate(transactionManager);
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public boolean reclaim(Execution execution) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            // 终态落库可能早于控制槽位释放，这段窗口仍由执行线程负责收尾。
            if (activity.isActive(Long.toString(execution.getId()))) return false;
            return repository.deleteReclaimable(execution.getId(), execution.getVersion());
        }));
    }
}

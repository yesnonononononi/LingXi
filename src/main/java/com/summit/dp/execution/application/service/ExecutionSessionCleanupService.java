package com.summit.dp.execution.application.service;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.Collection;
import java.util.List;

/**
 * 会话删除时的执行侧级联清理：删行在事务内，删检查点目录在提交后。
 *
 * <p><b>顺序不能反</b>：库是唯一权威。先删目录再删行，一旦事务回滚就留下「有行、没正文」的执行，
 * 恢复与重发会直接读空。现在最坏的情况是「行已删、目录还在」，那只是垃圾，由孤儿清扫带走。</p>
 *
 * <p><b>这里不做结束态判断</b>：调用方（会话删除入口）必须在调用前拦下仍有执行在跑的会话，
 * 否则运行线程收尾时会重新插入一条指向已删会话的孤儿行。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExecutionSessionCleanupService {

    private final ExecutionRepository executions;
    private final ExecutionResumeTaskRepository resumeTasks;
    private final ExecutionCheckpointMaintenance checkpoints;

    /**
     * 回收这批会话名下的执行行、恢复请求与检查点目录。
     *
     * @param sessionIds 会话 id 集合；空入参直接返回
     * @return 被清理的执行 id（按 id 升序）
     */
    public List<Long> deleteBySessions(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return List.of();
        }
        List<Long> executionIds = executions.findIdsBySessions(sessionIds);
        // 恢复请求只认执行 id，必须在执行行删掉之前取出来。
        int purgedTasks = resumeTasks.deleteByExecutionIds(executionIds);
        int deletedRows = executions.deleteBySessionIds(sessionIds);
        scheduleDirectoryCleanup(executionIds);
        log.info("清理会话执行数据: sessionCount={}, executionCount={}, deletedExecutions={},"
                        + " deletedResumeTasks={}", sessionIds.size(), executionIds.size(), deletedRows, purgedTasks);
        return executionIds;
    }

    /** 目录在提交后删：行已删，目录里的文件已全部失去引用，不需要再逐个比对。 */
    private void scheduleDirectoryCleanup(List<Long> executionIds) {
        if (executionIds.isEmpty()) {
            return;
        }
        Runnable cleanup = () -> executionIds.forEach(this::deleteDirectoryQuietly);
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            // 没有活动事务（直连调用/用例）：行已落库，直接同步删。
            cleanup.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                cleanup.run();
            }
        });
    }

    private void deleteDirectoryQuietly(Long executionId) {
        try {
            checkpoints.deleteExecutionDirectory(String.valueOf(executionId));
        } catch (RuntimeException failure) {
            // 会话已提交删除，目录删不掉只是垃圾：留给孤儿清扫，绝不让它把删除操作变成失败。
            log.warn("回收执行检查点目录失败，留待后续清理: executionId={}, error={}",
                    executionId, failure.toString());
        }
    }
}

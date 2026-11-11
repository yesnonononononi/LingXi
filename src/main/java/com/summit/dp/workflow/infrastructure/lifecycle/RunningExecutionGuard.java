package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.application.port.SessionDeletionGuard;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;

/**
 * 会话删除前的执行闸门：一次 {@code IN} 查询判断整棵树还有没有线程在写。
 *
 * <p>判据取「未终结」的投影，但只拦 {@code CREATED} / {@code RUNNING}：
 * {@code SUSPENDED} 是挂起等待，没有任何线程在跑，删掉会话正等于放弃这次挂起。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RunningExecutionGuard implements SessionDeletionGuard {

    private final ExecutionRepository executions;

    @Override
    public void requireNoRunningExecution(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        List<Execution> unfinished = executions.findUnfinishedBySessions(sessionIds);
        List<Long> running = unfinished.stream()
                .filter(execution -> ExecutionStatusCodes.isRunning(execution.getStatus()))
                .map(Execution::getId)
                .toList();
        if (running.isEmpty()) {
            return;
        }
        log.info("拒绝删除会话树: 仍有执行在运行, sessionCount={}, runningExecutions={}",
                sessionIds.size(), running);
        throw new ClientException("会话仍在执行中，请先停止后再删除");
    }
}

package com.summit.dp.execution.infrastructure.config;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;
import org.springframework.core.annotation.Order;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 启动执行收尸钩子：进程崩溃重启后，{@code execution} 表里遗留的 CREATED / RUNNING
 * 执行已没有任何线程负责收尾（框架执行循环随进程一起消失），若不清收，这些执行会
 * 永远停留在「进行中」——既污染「一个会话最多一个进行中执行」的单飞判定，也误导展示。
 * 启动完成时统一收口为 FAILED 终态（未完成是事实）。
 *
 * <p><b>安全边界</b>：只条件更新 {@code status IN (CREATED, RUNNING)}。SUSPENDED 行代表
 * 「已暂停待恢复」，必须保留，误标会让恢复入口消失；COMPLETED / FAILED / CANCELLED 等
 * 终态行不属于本钩子职责，绝不触碰。</p>
 *
 * <p><b>遗留恢复请求只收口、不重投</b>：恢复已改为「只尝试一次」。进程崩溃后留下的
 * READY / CLAIMED 请求代表「批准已落库、恢复没跑完」，自动重投会让同一段恢复执行两次，
 * 因此这里只做失败收口：执行已终态或代际已变的请求作废；其余请求把执行按框架失败链
 * 落终态并把请求标 FAILED。<b>完全没有遗留请求的 SUSPENDED 执行是「正常等待审批」，
 * 原样保留</b>，用户仍可经 {@code /resume} 手工恢复。</p>
 *
 * <p><b>顺序不可调换</b>：请求对应执行的状态必须在
 * {@link ExecutionRepository#markOrphanRunsFailed()} <b>之前</b>取快照 —— 收口会把崩溃时
 * 仍 RUNNING 的执行改成 FAILED，收口后再读就丢失「崩溃时是否正在 loop 中」的信息，
 * 无法区分「崩溃前就已是终态、请求本就作废」与「被本次收口终结」。</p>
 *
 * <p>收口是幂等的条件更新，重复启动 / 重复执行无副作用（第二次命中 0 行）。</p>
 */
@Slf4j
@Component
@Order(100)
@RequiredArgsConstructor
public class ExecutionStartupReaper implements ApplicationListener<ApplicationReadyEvent> {

    /** 遗留请求启动收口的批次上限；启动只处理有界的一批，避免拉全表。 */
    private static final int UNFINISHED_BATCH = 500;
    /** 已结束请求的回收窗口：巡检已随重试模型删除，终态回收只在启动时做一次。 */
    private static final long PURGE_AFTER_SECONDS = 3600L;

    private final ExecutionRepository executionRepository;
    private final ExecutionResumeTaskRepository resumeTaskRepository;
    private final ExecutionResumeCoordinator resumeCoordinator;

    @Override
    public void onApplicationEvent(@NonNull ApplicationReadyEvent event) {
        // 先快照遗留请求与它们此刻的执行状态，再收口孤儿运行。
        // 顺序不可颠倒：收口会把崩溃时仍 RUNNING 的执行改成 FAILED，若在收口之后才读状态，
        // 「崩溃时正在 loop 中」这一信息就没了。
        List<ExecutionResumeTask> leftover = resumeTaskRepository.listUnfinished(UNFINISHED_BATCH);
        Map<Long, Execution> snapshots = readExecutionSummaries(leftover);

        int reaped = executionRepository.markOrphanRunsFailed();
        log.info("execution 表遗留 CREATED/RUNNING 已收口为 FAILED，共 {} 行", reaped);

        int closed = closeLeftoverRequests(leftover, snapshots);
        if (closed > 0) {
            log.info("启动收口遗留恢复请求，共 {} 条", closed);
        }

        int purged = resumeTaskRepository.purgeFinishedBefore(Instant.now().minusSeconds(PURGE_AFTER_SECONDS));
        if (purged > 0) {
            log.info("回收已结束的恢复请求，共 {} 条", purged);
        }
    }

    /**
     * 逐条收口遗留请求：只失败收口，绝不重新派发。
     *
     * <p>执行已终态（崩溃前就结束了）或代际已变（期间又挂起过一次）的请求直接作废 ——
     * 前者已无恢复对象，后者的新挂起边界是合法的等待，不能被旧请求连坐。其余（仍 SUSPENDED
     * 或崩溃时正在 loop 中）说明恢复没跑完：把执行按框架失败链落终态，请求标 FAILED。
     * 崩溃时 RUNNING 的执行已被 {@link ExecutionRepository#markOrphanRunsFailed()} 收口，
     * 这里的收口对它是幂等的空操作。</p>
     *
     * @param leftover  收口前读到的遗留请求
     * @param snapshots 上述请求对应执行在收口前的状态摘要
     * @return 本批次实际处置的请求条数
     */
    private int closeLeftoverRequests(List<ExecutionResumeTask> leftover, Map<Long, Execution> snapshots) {
        int handled = 0;
        for (ExecutionResumeTask task : leftover) {
            Execution snapshot = snapshots.get(task.getExecutionId());
            if (supersedeIfMoot(task, snapshot)) {
                handled++;
                continue;
            }
            // 恢复没跑完：执行收口为 FAILED，请求标 FAILED，不再自动派发。
            resumeCoordinator.closeStartupFailure(task.getExecutionId(),
                    "进程崩溃时恢复未完成，无法确认是否已产生副作用");
            markFailed(task, "进程崩溃时恢复未完成，无法确认是否已产生副作用，只收口不重投");
            handled++;
        }
        return handled;
    }

    /** 批量读一批请求对应执行的摘要（状态 + 代际），供收口前快照使用。 */
    private Map<Long, Execution> readExecutionSummaries(List<ExecutionResumeTask> tasks) {
        if (tasks.isEmpty()) {
            return Map.of();
        }
        List<Long> executionIds = tasks.stream().map(ExecutionResumeTask::getExecutionId).distinct().toList();
        Map<Long, Execution> summaries = new HashMap<>();
        for (Execution summary : executionRepository.findSummariesByIds(executionIds)) {
            if (summary.getId() != null) {
                summaries.put(summary.getId(), summary);
            }
        }
        return summaries;
    }

    /**
     * 请求是否已无意义：执行行缺失、执行已终态，或代际已变。
     *
     * <p>代际已变意味着执行期间又挂起过一次，当前挂起边界是合法的等待，旧请求不能连坐它。</p>
     */
    private boolean supersedeIfMoot(ExecutionResumeTask task, Execution snapshot) {
        if (snapshot == null) {
            markSuperseded(task, "执行行缺失，恢复请求作废");
            return true;
        }
        if (ExecutionStatusCodes.isTerminal(snapshot.getStatus())) {
            markSuperseded(task, "执行已终态，恢复请求作废");
            return true;
        }
        long generation = snapshot.getResumeGeneration() == null ? 0L : snapshot.getResumeGeneration();
        if (generation != task.getGeneration()) {
            markSuperseded(task, "恢复代际已变更，请求作废");
            return true;
        }
        return false;
    }

    private void markSuperseded(ExecutionResumeTask task, String reason) {
        if (!task.supersede()) {
            return;
        }
        if (!resumeTaskRepository.updateState(task)) {
            log.debug("恢复请求作废时状态已变化: taskId={}, reason={}", task.getId(), reason);
            return;
        }
        log.info("遗留恢复请求作废: taskId={}, executionId={}, reason={}",
                task.getId(), task.getExecutionId(), reason);
    }

    private void markFailed(ExecutionResumeTask task, String reason) {
        task.fail(reason);
        if (!resumeTaskRepository.updateState(task)) {
            log.warn("恢复请求失败状态未能落库（可能已被改写）: taskId={}, executionId={}",
                    task.getId(), task.getExecutionId());
            return;
        }
        log.warn("遗留恢复请求收口为 FAILED（禁止自动重投）: taskId={}, executionId={}",
                task.getId(), task.getExecutionId());
    }
}

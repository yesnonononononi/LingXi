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
import java.util.Objects;

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
 * <p><b>遗留 CLAIMED 恢复任务按恢复边界分流（架构 §10.1）</b>：{@code CLAIMED} 只说明
 * 「某个 worker 领到过这条任务」，不代表它没跑完 —— 模型可能已经跑了一半。崩溃后把它当
 * 未启动重跑，等于让同一段恢复执行两次；但直接删又会丢失「领取后崩溃、尚未 resume」窗口里的
 * 恢复意图。因此单查遗留 CLAIMED，按「执行是否已终态 / 代际是否过期 / 是否仍停在挂起点」
 * 四路分流，无法证明未跨边界的一律标记需人工处理、禁止自动重跑。</p>
 *
 * <p>收口是幂等的条件更新（见 {@link ExecutionRepository#markOrphanRunsFailed()}），
 * 重复启动 / 重复执行无副作用（第二次命中 0 行）。</p>
 *
 * <p><b>顺序不可调换</b>：实际的重新派发必须发生在收口之后 —— 反过来会让刚被重新派发的执行
 * 在下一步被自己的收尸条件更新标成 FAILED。为此遗留 CLAIMED 的执行状态在收口<b>前</b>取快照、
 * 派发动作在收口<b>后</b>执行，两者既保住了「按收口前状态判副作用」的口径，又不踩收口误标。</p>
 */
@Slf4j
@Component
@Order(100)
@RequiredArgsConstructor
public class ExecutionStartupReaper implements ApplicationListener<ApplicationReadyEvent> {

    /** 遗留 CLAIMED 启动分流的批次上限；启动只处理有界的一批，避免拉全表。 */
    private static final int CLAIMED_BATCH = 500;

    private final ExecutionRepository executionRepository;
    private final ExecutionResumeTaskRepository resumeTaskRepository;
    private final ExecutionResumeCoordinator resumeCoordinator;

    @Override
    public void onApplicationEvent(@NonNull ApplicationReadyEvent event) {
        // 先快照遗留 CLAIMED 与它们此刻的执行状态，再收口孤儿运行。
        // 顺序不可颠倒：收口会把崩溃时仍 RUNNING 的执行改成 FAILED 终态，若在收口之后才读状态，
        // 「恢复已跑了一半」就会被误判成「执行已终态 → 作废」，把「副作用不明、需人工」抹掉。
        List<ExecutionResumeTask> leftoverClaimed = resumeTaskRepository.listClaimed(CLAIMED_BATCH);
        Map<Long, Execution> claimedSnapshots = readExecutionSummaries(leftoverClaimed);

        int reaped = executionRepository.markOrphanRunsFailed();
        log.info("execution 表遗留 CREATED/RUNNING 已收口为 FAILED，共 {} 行", reaped);

        int triaged = triageLeftoverClaimed(leftoverClaimed, claimedSnapshots);
        if (triaged > 0) {
            log.info("启动分流遗留 CLAIMED 恢复任务，共 {} 条", triaged);
        }

        int redispatched = redispatchPendingResumes();
        if (redispatched > 0) {
            log.info("启动后重新派发未启动的恢复任务，共 {} 条", redispatched);
        }
    }

    /**
     * 重新派发「确实没启动过」的恢复任务。
     *
     * <p><b>只判两条，其余交给协调器</b>：本钩子筛掉「一定不该重跑」的代际过期者，
     * 其余推回流水线，由协调器在真正跑之前核对「执行是否终态」「是否还有未决槽位」——
     * 判闸门逻辑只留一份，重复实现必然走偏。</p>
     *
     * <p>{@code listDispatchable} 的状态条件为 {@code IN (READY, FAILED)}，因此这里拿不到
     * CLAIMED 行；遗留 CLAIMED 由 {@link #triageLeftoverClaimed} 单独分流。</p>
     *
     * @return 重新派发的任务条数
     */
    private int redispatchPendingResumes() {
        List<ExecutionResumeTask> pending = resumeTaskRepository.listDispatchable(Instant.now(), 200);
        int dispatched = 0;
        for (ExecutionResumeTask task : pending) {
            long generation = executionRepository.findResumeGeneration(task.getExecutionId());
            if (generation != task.getGeneration()) {
                log.info("跳过代际已过期的恢复任务: taskId={}, executionId={}, taskGeneration={}, currentGeneration={}",
                        task.getId(), task.getExecutionId(), task.getGeneration(), generation);
                continue;
            }
            // 交给协调器走同一条派发路径：它领取时会再核对一次终态与未决槽位，
            // 这里只负责把「值得一试」的任务推回流水线，不重复它的判闸门逻辑。
            resumeCoordinator.dispatch(task.getExecutionId());
            dispatched++;
        }
        return dispatched;
    }

    /**
     * 启动分流遗留 CLAIMED 任务（架构 §10.1）。
     *
     * <p><b>为什么必须按状态与代际分流，而不是删或盲目重跑</b>：CLAIMED 只表示「领取成功」，
     * 不能证明恢复已经开始。存在这个窗口 —— 领取并提交 CLAIMED → 进程崩溃 → 尚未调用 resume，
     * 执行仍为 SUSPENDED。此时直接删会留下「决策已提交、执行永久暂停」，丢失恢复意图；
     * 而盲目重跑则可能让已跑过一半的恢复再跑一次。</p>
     *
     * <p><b>恢复边界判据</b>：框架 {@code RuntimeProcessorTemplate.process} 的顺序是
     * {@code save(execution)} → 若 resumed 则 {@code Execution.resumeChecked} + {@code save}
     * → 进 loop。即<b>恢复后的状态先落库，才进入模型与工具执行</b>。因此「执行状态是否已离开
     * 挂起点」就是「是否跨过边界」的判据：仍为 SUSPENDED 且代际一致 → 证明恢复尚未真正开始，
     * 可安全重投；否则不能自动重跑。</p>
     *
     * <p>四路处置：执行已终态 → 作废；代际过期 → 作废；仍 SUSPENDED 且代际一致 → 退回可派发态；
     * 其余（已脱离挂起点但非终态，副作用不明）→ 标记需人工处理，禁止自动重跑。</p>
     *
     * <p>状态用<b>收口前的快照</b>判定：崩溃时仍 RUNNING 的执行随后会被孤儿收口改成 FAILED，
     * 若按收口后的状态看就会被误判成「已终态 → 作废」，抹掉真正需要人工的那一类。</p>
     *
     * @param claimed          收口前读到的遗留 CLAIMED 任务
     * @param claimedSnapshots 上述任务对应执行在收口前的状态摘要
     * @return 本批次实际处置的任务条数
     */
    private int triageLeftoverClaimed(List<ExecutionResumeTask> claimed, Map<Long, Execution> claimedSnapshots) {
        int handled = 0;
        for (ExecutionResumeTask task : claimed) {
            Execution summary = claimedSnapshots.get(task.getExecutionId());
            if (supersedeIfDead(task, summary)) {
                handled++;
                continue;
            }
            if (canResumeWithinBoundary(task, summary)) {
                resumeCoordinator.dispatch(task.getExecutionId());
                handled++;
            } else {
                flagForManual(task);
                handled++;
            }
        }
        return handled;
    }

    /** 批量读一批恢复任务对应执行的摘要（状态 + 代际），供收口前快照使用。 */
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

    /** 执行已终态或代际已过期 → 作废；返回 true 表示已处置，无需继续分流。 */
    private boolean supersedeIfDead(ExecutionResumeTask task, Execution summary) {
        Integer status = summary == null ? null : summary.getStatus();
        if (ExecutionStatusCodes.isTerminal(status)) {
            if (task.supersede()) {
                resumeTaskRepository.updateState(task);
            }
            log.info("遗留 CLAIMED 任务作废（执行已终态）: taskId={}, executionId={}, status={}",
                    task.getId(), task.getExecutionId(), status);
            return true;
        }
        Long currentGeneration = summary == null ? null : summary.getResumeGeneration();
        long generation = currentGeneration == null ? 0L : currentGeneration;
        if (summary != null && generation != task.getGeneration()) {
            if (task.supersede()) {
                resumeTaskRepository.updateState(task);
            }
            log.info("遗留 CLAIMED 任务作废（代际已过期）: taskId={}, executionId={}, taskGeneration={}, currentGeneration={}",
                    task.getId(), task.getExecutionId(), task.getGeneration(), generation);
            return true;
        }
        return false;
    }

    /**
     * 能否证明未跨恢复边界：执行行存在、仍为 SUSPENDED 且与任务代际一致。
     *
     * <p>执行行缺失（summary 为 null）视为无法证明，不返回 true。</p>
     */
    private boolean canResumeWithinBoundary(ExecutionResumeTask task, Execution summary) {
        return summary != null
                && ExecutionStatusCodes.isSuspended(summary.getStatus())
                && Objects.equals(task.getGeneration(), summary.getResumeGeneration());
    }

    /** 无法证明未跨边界：标记需人工处理，禁止自动重跑。 */
    private void flagForManual(ExecutionResumeTask task) {
        task.flagForManual("领取后进程崩溃且执行已离开挂起点，无法确认是否已产生副作用");
        if (!resumeTaskRepository.updateState(task)) {
            log.warn("遗留 CLAIMED 任务标记人工处理失败（状态已被改写）: taskId={}, executionId={}",
                    task.getId(), task.getExecutionId());
            return;
        }
        log.warn("遗留 CLAIMED 任务标记需人工处理（禁止自动重跑）: taskId={}, executionId={}, attempts={}",
                task.getId(), task.getExecutionId(), task.getAttempts());
    }
}

package com.summit.dp.workflow.infrastructure.lifecycle.startup;

import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

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
 * <p><b>遗留恢复请求按来源与状态分治，不再一律收口</b>：{@code READY} / {@code DEFERRED} 且执行
 * <b>仍 SUSPENDED</b>、代际一致的请求，代表「决策已落库、恢复没跑完」——进程崩溃前用户那次批准
 * 是有效决定，重启后必须按<b>库内来源</b>重投（人工来源不受 {@code AUTO_ROUNDS} 限制）。
 * {@code CLAIMED}（崩溃时已在 loop 中）无法确认是否已产生副作用，仍按既有安全策略失败收口；
 * 代际过期 / 执行已终态则作废。<b>完全没有遗留请求的 SUSPENDED 执行是「正常等待审批」，
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
    /**
     * 单批处理的待收口条数。
     *
     * <p><b>为什么从 500 收到 100</b>：批大小原来承担「一次启动能处理多少」的语义，越大越好；
     * 现在由游标翻页负责覆盖任意量，批大小的作用变成「一轮的延迟上限」，越小越公平 ——
     * 每条补做都要读检查点正文并跨模块收口，一批 100 条既能摊平瞬时故障的影响，
     * 也不会让「一条卡住」把整批拖成一眼看不到头的等待。游标查询本身只取一列走索引，多翻几页无成本。</p>
     */
    private static final int CLOSURE_BATCH = 100;
    /**
     * 消费轮次上限：防一条永远失败的项把轮转变成永动机。
     *
     * <p>退避 {@value #CLOSURE_BACKOFF_MILLIS} 毫秒 × {@value #CLOSURE_ROUNDS_LIMIT} 轮 ≈ 10 秒的进程内
     * 重试窗口：足够覆盖瞬时故障（锁竞争、短暂不可用），又不会无限占着后台线程。用尽后待收口位
     * 留在库里，等该执行下次落库或下次启动。</p>
     */
    private static final int CLOSURE_ROUNDS_LIMIT = 200;
    /** 轮间退避：既让瞬时故障（锁竞争、短暂不可用）有机会自愈，也不至于把线程烧满。 */
    private static final long CLOSURE_BACKOFF_MILLIS = 50L;
    /** 任务名：进日志与受管执行器的丢弃告警，便于定位是谁的后台任务。 */
    public static final String TASK_CLOSURE_REPAIR = "execution-startup-closure-repair";
    /** 已结束请求的回收窗口：巡检已随重试模型删除，终态回收只在启动时做一次。 */
    private static final long PURGE_AFTER_SECONDS = 3600L;

    private final ExecutionRepository executionRepository;
    private final ExecutionResumeTaskRepository resumeTaskRepository;
    private final ExecutionResumeCoordinator resumeCoordinator;
    /** 检查点读取口：补做收口要拿到带属性的完整执行，摘要里没有那些字段。 */
    private final com.summit.core.runtime.loop.ExecutionRepository checkpointRepository;
    /** 收口补偿入口：幂等，靠各协作方的状态判据去重。 */
    private final ExecutionLifecycleProjection lifecycleProjection;
    /** 受管异步执行器：待收口项的消费必须跑在受管线程上，启动线程只负责提交。 */
    private final ManagedAsyncExecutor asyncExecutor;

    @Override
    public void onApplicationEvent(@NonNull ApplicationReadyEvent event) {
        // 启动线程只做「有界、不去重不重要」的收尾：读一批遗留请求、收口孤儿运行、回收旧请求。
        // 这些动作与待办数量无关（固定 1 次查询 + 1 次条件 UPDATE + 1 次删除）。
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

        // 待收口项的消费量与库里的待办量成正比，绝不能留在启动线程里：只提交，立刻返回。
        triggerClosureRepair();
    }

    /**
     * 按「待收口位」把上一进程没做完的收口补上。
     *
     * <p><b>为什么这一列能覆盖崩溃窗口</b>：{@code closure_pending} 与「状态写成终态」由同一条
     * UPDATE 写入（{@link com.summit.dp.execution.application.service.ExecutionCheckpointService#save}），
     * 所以只要终态落库了，就必然留下一条「还要收口」的事实。进程崩在提交与 afterCommit 之间时，
     * 内存里什么都没有，但这一列在库里 —— 这正是旧的「检查点属性标记」覆盖不到的场景
     * （标记是提交之后才写进内存的，且它只跟着「下一次保存」走）。</p>
     *
     * <p><b>不看遗留恢复请求</b>：那条路径要求「崩溃前正好有一次恢复」，而绝大多数终态执行
     * 根本没有恢复请求。这里只按 {@code closure_pending = 1} 这一条窄查询找活，与本批
     * 遗留请求的处置完全独立。</p>
     *
     * <p><b>启动段只触发、不处理</b>：真正的扫描交给 {@link ManagedAsyncExecutor}，启动线程立刻返回。
     * 启动耗时因此与待办数量无关 —— 待办一万条也不会把 Spring 的
     * {@code ApplicationReadyEvent} 拖住。</p>
     */
    private void triggerClosureRepair() {
        boolean accepted = asyncExecutor.tryExecute(TASK_CLOSURE_REPAIR, this::drainPendingClosures);
        if (!accepted) {
            // 关停瞬间被拒：待收口位仍在库里，下次启动或该执行下一次落库会重做，不丢事实。
            log.warn("启动补做收口的任务未被受理（执行器已关闭），待收口事实留在库里待下次启动: task={}",
                    TASK_CLOSURE_REPAIR);
        }
    }

    /**
     * 消费待收口项：有界批次 + 游标翻页 + 公平轮转，直到清空或轮次用尽。
     *
     * <p><b>有界批次</b>：每批 {@value #CLOSURE_BATCH} 条。批大小压到 500（= 原来的一次性上限）而不是
     * 更大，是因为每条补做都要读一次检查点正文并跨模块收口，单批再放大只会让「一批里失败一条」
     * 的代价变高，不会更快清空。</p>
     *
     * <p><b>游标 + 公平轮转</b>：一轮按 {@code id > cursor} 向后翻页直到取不满一批，然后游标归零，
     * 下一轮从头再来。失败项<b>在同一轮里最多尝试一次</b>，失败只记日志、跳过继续处理后面的项 ——
     * 否则「前 N 条一直失败」会把后面的项饿死（旧的单批扫一轮就有这个问题）。</p>
     *
     * <p><b>为什么必须在进程内重试</b>：一旦这次执行不再落库，进程里就再没有别的触发点。
     * 只靠「下次启动」意味着用户要等到重启才能看到轮次收口，而这不是可接受的语义。</p>
     *
     * <p><b>什么时候停</b>：清空即停；另外轮次有上限 {@value #CLOSURE_ROUNDS_LIMIT}，防止一条
     * 永远失败的项把这里变成永动机 —— 用尽后待收口位仍留在库里，等该执行下次落库或下次启动。</p>
     */
    private void drainPendingClosures() {
        long cursor = 0L;
        int round = 0;
        while (round < CLOSURE_ROUNDS_LIMIT && !Thread.currentThread().isInterrupted()) {
            List<Long> pending;
            try {
                pending = executionRepository.findClosurePendingIdsAfter(cursor, CLOSURE_BATCH);
            } catch (RuntimeException failure) {
                log.error("读取待收口项失败，本轮放弃: cursor={}, error={}", cursor, failure.toString(), failure);
                return;
            }
            if (pending.isEmpty()) {
                if (cursor == 0L) {
                    if (round > 0) {
                        log.info("启动补做收口完成，共 {} 轮", round);
                    }
                    return;
                }
                // 本轮翻到底：游标归零，退避后从头再来。
                cursor = 0L;
                round++;
                if (!awaitNextRound()) {
                    return;
                }
                continue;
            }
            for (Long executionId : pending) {
                repairOne(executionId);
            }
            cursor = pending.get(pending.size() - 1);
            if (pending.size() < CLOSURE_BATCH) {
                // 这一页没取满说明已经到底：直接进入下一轮，省一次空查询。
                cursor = 0L;
                round++;
                if (pendingCountIsZero()) {
                    log.info("启动补做收口完成，共 {} 轮", round);
                    return;
                }
                if (!awaitNextRound()) {
                    return;
                }
            }
        }
        log.warn("启动补做收口轮次用尽仍有余量，待收口事实留在库里: rounds={}, 待下次落库或下次启动",
                CLOSURE_ROUNDS_LIMIT);
    }

    /**
     * 补做一条待收口事实。
     *
     * <p><b>单条失败绝不打断整轮</b>：一条收口失败不代表后面的项也失败，跳过继续处理才是公平的。
     * 失败项仍是 {@code closure_pending = 1}，由下一轮或下次启动重试。</p>
     *
     * <p><b>不在这里再读一次「是否清位」</b>：收口成功与否已由 {@code completeClosure} 自己的日志
     * 表达（失败带步骤名且不清位），每条多一次 SELECT 只会把消费一轮的耗时翻倍。</p>
     */
    private void repairOne(Long executionId) {
        if (executionId == null) {
            return;
        }
        try {
            // 用 Optional 的 map 承接，是为了让框架执行对象的类型由上下文推断 ——
            // 它与业务侧 Execution 同名，写出来就得用全类名，方法体内出现全类名是 AGENTS 明确禁止的。
            boolean closed = checkpointRepository.findById(String.valueOf(executionId))
                    .map(execution -> {
                        // 收口脚本 + 清待收口位 + 广播/唤醒：与正常收尾走同一个入口，靠状态判据去重。
                        // 补偿声明为 true：框架那次成功终态在发布时已被门禁拦下，再没有人会补发。
                        lifecycleProjection.completeClosure(execution,
                                execution.getExecutionState() == ExecutionState.CANCELLED, true);
                        return Boolean.TRUE;
                    })
                    .orElse(Boolean.FALSE);
            if (!closed) {
                log.warn("启动补做收口跳过：检查点读不到, executionId={}", executionId);
            }
        } catch (RuntimeException failure) {
            log.error("启动补做收口失败，跳过本项继续: executionId={}, error={}",
                    executionId, failure.toString(), failure);
        }
    }

    /** 轮间退避；被打断就返回 {@code false} 让消费停止。 */
    private boolean awaitNextRound() {
        try {
            TimeUnit.MILLISECONDS.sleep(CLOSURE_BACKOFF_MILLIS);
            return true;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** 待办是否已全部清空（库内事实，不看内存计数）。 */
    private boolean pendingCountIsZero() {
        try {
            return executionRepository.findClosurePendingIds(1).isEmpty();
        } catch (RuntimeException failure) {
            log.error("确认待收口是否清空失败，按未清空处理: error={}", failure.toString(), failure);
            return false;
        }
    }

    /**
     * 逐条处置遗留请求：按<b>请求状态 + 执行事实 + 代际</b>三分，而不是一律失败收口。
     *
     * <p><b>为什么不能一律 FAILED</b>：{@code READY}（已受理、还没开始跑）的同代际人工审批，
     * 决策已经落库、执行仍挂在 SUSPENDED —— 这正是「点完批准、进程崩了」的形态。把它烧成 FAILED
     * 等于把用户那次批准静默作废，而 {@code trigger_type} 白存了。恢复的危害只存在于
     * 「已经跑起来、不知道跑到了哪」的那一侧。</p>
     *
     * <p><b>判定（逐条说明依据）</b>：</p>
     * <ol>
     *   <li>执行行缺失 / 执行已终态 / 代际已变 → 作废。前两者已无恢复对象，后者说明期间又挂起过，
     *       当前挂起边界是合法的等待，不能被旧请求连坐。</li>
     *   <li>{@code READY} / {@code DEFERRED} 且执行<b>仍 SUSPENDED</b> → 交给
     *       {@link ExecutionResumeCoordinator#dispatch(long)} 按<b>库内来源</b>重投。
     *       门禁不通过自然会再落回 {@code DEFERRED}：人工来源不受 {@code AUTO_ROUNDS} 限制，
     *       {@code USER_PAUSED} 仍拦。</li>
     *   <li>{@code CLAIMED}（已开始跑，崩在运行中），或执行已不在挂起态 → 保持既有安全策略：
     *       失败收口 + 请求 FAILED。此时无法确认是否已产生副作用，重投会让同一段执行跑两次。</li>
     * </ol>
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
            if (resumable(task, snapshot)) {
                requeueAndReplay(task);
                handled++;
                continue;
            }
            // 已开始跑却崩在运行中：无法确认副作用边界，只收口不重投。
            resumeCoordinator.closeStartupFailure(task.getExecutionId(),
                    "进程崩溃时恢复未完成，无法确认是否已产生副作用");
            markFailed(task, "进程崩溃时恢复未完成，无法确认是否已产生副作用，只收口不重投");
            handled++;
        }
        return handled;
    }

    /**
     * 这条遗留请求是否可以按库内来源重投。
     *
     * <p>两个条件缺一不可：请求还没被领取（{@code READY} / {@code DEFERRED}），且执行确实还挂在
     * {@code SUSPENDED}。代际与终态已在 {@link #supersedeIfMoot} 判过。</p>
     */
    private static boolean resumable(ExecutionResumeTask task, Execution snapshot) {
        ResumeTaskState state = task.getState();
        boolean notStarted = state == ResumeTaskState.READY || state == ResumeTaskState.DEFERRED;
        return notStarted && snapshot.getStatus() != null && snapshot.getStatus() == ExecutionStatusCodes.SUSPENDED;
    }

    /**
     * 把请求重新排回可领取状态并触发一次派发。
     *
     * <p>{@code DEFERRED} 必须先显式改回 {@code READY}：领取是带 {@code state = READY} 条件的
     * 条件更新，直接派发只会一次次领取失败。改状态失败（版本被别人推进）就跳过 ——
     * 说明此刻已有别的路径在处置这条请求。</p>
     */
    private void requeueAndReplay(ExecutionResumeTask task) {
        if (task.requeueIfDeferred() && !resumeTaskRepository.updateState(task)) {
            log.info("遗留恢复请求重新排队时状态已变化，跳过: taskId={}, executionId={}",
                    task.getId(), task.getExecutionId());
            return;
        }
        log.info("遗留恢复请求按库内来源重投: taskId={}, executionId={}, source={}",
                task.getId(), task.getExecutionId(), task.effectiveTrigger());
        resumeCoordinator.dispatch(task.getExecutionId());
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

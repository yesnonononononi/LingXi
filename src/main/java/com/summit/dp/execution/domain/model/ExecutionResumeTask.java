package com.summit.dp.execution.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * 一次「把某个执行恢复到 loop」的<b>请求</b>，不是执行本身。
 *
 * <p><b>为什么要有这张表</b>：决策事务提交与「把恢复动作派发出去」之间存在进程崩溃窗口 ——
 * 用户点了批准、决策已落库，恢复却没派发，进程就死了。请求先落库、派发后置，重启时才能
 * 区分「正常等待审批的 SUSPENDED」与「已批准但恢复没起步的 SUSPENDED」。反过来
 * （先派发后落库）会在崩溃后留下无人认领的恢复。</p>
 *
 * <p><b>只保存请求，不保存事件</b>：没有逐事件日志，恢复靠的是已提交检查点。
 * 本表若开始存事件就意味着要实现重放，那不在本方案范围内。</p>
 *
 * <p><b>代际是防重放的锚点</b>：执行每次真正转入 SUSPENDED 时代际 +1。请求与执行当前
 * 代际不一致即 {@link #supersede} 作废 —— 旧挂起点的恢复请求没有理由作用在新挂起点上。</p>
 *
 * <p><b>只尝试一次</b>：批准即「决策已落库、后端只恢复一次」，启动失败就 {@link #fail} 收口，
 * 没有退避、不重试。因此本模型不再保存尝试次数与下次派发时刻。</p>
 */
@Getter
@Builder
public class ExecutionResumeTask {

    private final Long id;
    private final Long executionId;
    /** 受理时的恢复代际，必须与 {@code execution.resume_generation} 一致才可派发。 */
    private final long generation;
    private ResumeTaskState state;
    private String errorReason;
    @Builder.Default
    private long version = 1L;
    private final Instant createdAt;
    private Instant updatedAt;

    /**
     * 本次恢复的触发来源；{@code null} 表示升级前的遗留请求（当时来源没落库）。
     *
     * <p><b>为什么来源必须是持久字段而不是调用参数</b>：它决定消费端复检的门禁口径。
     * 只放在内存里，进程崩溃后重投就没有它了 —— 人工批准会被自动轮次上限判掉并静默作废，
     * 而回执当时说的是「已受理」。</p>
     */
    private ResumeSource triggerType;

    public void acceptPersistedVersion(long nextVersion) {
        this.version = nextVersion;
    }

    /**
     * 本次恢复实际按哪个来源判定门禁。
     *
     * <p><b>遗留行（来源为 NULL）按 {@link ResumeSource#AUTO_INPUT_WAKEUP} 处理</b>：
     * 升级前的写入方只有审批与人工补充，但库上分辨不出来；选保守方向 —— 自动唤醒要过全部门禁
     * （含自动轮次上限），最坏结果只是「极少数历史审批需要用户手动点一次恢复」，
     * 而反向选择会让一次崩溃替用户批准工具。调用方在取到回退值时记一条日志，
     * 使「按旧数据口径处理」在日志里可追。</p>
     */
    public ResumeSource effectiveTrigger() {
        return triggerType == null ? ResumeSource.AUTO_INPUT_WAKEUP : triggerType;
    }

    /** 该请求是否缺少持久化来源（升级前的遗留行）。 */
    public boolean lacksPersistedTrigger() {
        return triggerType == null;
    }

    /**
     * 合并新来源：<b>人工优先，只升不降</b>。
     *
     * <p>同一挂起点上先来了自动唤醒、后来人点了批准，行只有一条（唯一索引钉死），
     * 因此必须把来源升级成人工 —— 否则后到的人工决策会沿用先到的自动口径被轮次上限判掉。</p>
     *
     * @param source 本次触发的来源；{@code null} 视为没有新信息
     * @return 是否真的改了来源（调用方据此决定要不要写库）
     */
    public boolean promoteSource(ResumeSource source) {
        if (source == null) {
            return false;
        }
        if (triggerType == source) {
            return false;
        }
        // 人工来源覆盖一切（含遗留 NULL 与自动唤醒）；自动来源只填补 NULL。
        if (source.humanInitiated() || triggerType == null) {
            this.triggerType = source;
            this.updatedAt = Instant.now();
            return true;
        }
        return false;
    }

    /**
     * 门禁没放行：置为 {@link ResumeTaskState#DEFERRED} 并留下原因。
     *
     * <p>刻意不用 {@link #supersede()}：作废是「这次恢复永久没机会了」，而门禁不通过只是
     * 「此刻还不行」。留在未完成态，下一次受理（人或自动唤醒）可以重新排回 READY。</p>
     */
    public void defer(String reason) {
        if (state == ResumeTaskState.SUCCEEDED || state == ResumeTaskState.SUPERSEDED) {
            return;
        }
        this.state = ResumeTaskState.DEFERRED;
        this.errorReason = reason == null ? "恢复门禁未放行" : reason;
        this.updatedAt = Instant.now();
    }

    /** 把待观察的请求重新排入可领取状态；非 DEFERRED 不动。 */
    public boolean requeueIfDeferred() {
        if (state != ResumeTaskState.DEFERRED) {
            return false;
        }
        this.state = ResumeTaskState.READY;
        this.updatedAt = Instant.now();
        return true;
    }

    /**
     * 领取：READY → CLAIMED。
     *
     * <p><b>为什么不在这里判状态</b>：条件（state、version）由仓储的 LambdaUpdateWrapper
     * 表达，判行数才准；领域侧再判一次反而可能与 SQL 条件不一致。</p>
     */
    public void claim() {
        this.state = ResumeTaskState.CLAIMED;
        this.errorReason = null;
        this.updatedAt = Instant.now();
    }

    /** 恢复完成。 */
    public void succeed() {
        this.state = ResumeTaskState.SUCCEEDED;
        this.errorReason = null;
        this.updatedAt = Instant.now();
    }

    /**
     * 启动失败已收口：记录原因，不再派发。
     *
     * <p>决策本身已落库、不会回退 —— 本方法只说明「这次恢复没能起步」，
     * 用户仍可手工重试恢复。</p>
     */
    public void fail(String reason) {
        this.state = ResumeTaskState.FAILED;
        this.errorReason = reason == null ? "恢复失败" : reason;
        this.updatedAt = Instant.now();
    }

    /**
     * 作废：代际已变、执行已终结，或已确认由另一合法运行接管。
     *
     * <p>幂等：已终态任务不再改写，避免「取消一个已失败任务」把失败原因抹掉。</p>
     */
    public boolean supersede() {
        if (state == ResumeTaskState.SUCCEEDED || state == ResumeTaskState.SUPERSEDED) {
            return false;
        }
        this.state = ResumeTaskState.SUPERSEDED;
        this.updatedAt = Instant.now();
        return true;
    }
}

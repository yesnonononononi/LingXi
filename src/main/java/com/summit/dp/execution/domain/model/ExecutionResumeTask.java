package com.summit.dp.execution.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * 一次「把某个执行恢复到 loop」的<b>意图</b>，不是执行本身。
 *
 * <p><b>为什么要有这张表</b>：决策事务提交与「把恢复任务丢给线程池」之间存在进程崩溃窗口 ——
 * 用户点了批准、决策已落库，但恢复动作还没派发，进程就死了。恢复意图先落库、派发后置，
 * 重启时按意图重新派发即可；反过来（先派发后落库）则会在崩溃后留下「没人认领的恢复」。</p>
 *
 * <p><b>只保存意图，不保存事件</b>：没有逐事件日志，恢复靠的是已提交检查点。
 * 本表若开始存事件就意味着要实现重放，那不在本方案范围内。</p>
 *
 * <p><b>代际是防重放的锚点</b>：执行每次真正转入 SUSPENDED 时代际 +1。任务与执行当前
 * 代际不一致即 {@link #supersede} 作废 —— 旧挂起点的恢复意图没有理由作用在新挂起点上。</p>
 */
@Getter
@Builder
public class ExecutionResumeTask {

    private final Long id;
    private final Long executionId;
    /** 受理时的恢复代际，必须与 {@code execution.resume_generation} 一致才可派发。 */
    private final long generation;
    private ResumeTaskState state;
    private int attempts;
    private Instant nextAttemptAt;
    private String errorReason;
    @Builder.Default
    private long version = 1L;
    private final Instant createdAt;
    private Instant updatedAt;

    public void acceptPersistedVersion(long nextVersion) {
        this.version = nextVersion;
    }

    /**
     * 领取：READY/FAILED → CLAIMED，尝试次数 +1。
     *
     * <p><b>为什么不在这里判状态</b>：条件（state、version、nextAttemptAt）由仓储的
     * LambdaUpdateWrapper 表达，判行数才准；领域侧再判一次反而可能与 SQL 条件不一致。</p>
     */
    public void claim() {
        this.state = ResumeTaskState.CLAIMED;
        this.attempts++;
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
     * 恢复失败：记录原因并给出退避时刻。
     *
     * <p>决策本身已落库、不会回退 —— 本方法只影响「还要不要再跑一次 loop」，
     * 用户仍可手工重试恢复。</p>
     */
    public void fail(String reason, Instant retryAt) {
        this.state = ResumeTaskState.FAILED;
        this.errorReason = reason == null ? "恢复失败" : reason;
        this.nextAttemptAt = retryAt;
        this.updatedAt = Instant.now();
    }

    /**
     * 推迟到 {@code retryAt} 再试：状态回到可派发，但<b>不记失败原因</b>。
     *
     * <p><b>为什么不用 {@link #fail} 传空原因</b>：{@code fail} 会把空原因兜底成
     * 「恢复失败」，而「还有槽位没落定」根本不是失败 —— 让用户看到恢复坏了、
     * 去点一个根本没坏的恢复入口，比多等两秒糟糕得多。</p>
     */
    public void deferTo(Instant retryAt) {
        this.state = ResumeTaskState.FAILED;
        this.errorReason = null;
        this.nextAttemptAt = retryAt;
        this.updatedAt = Instant.now();
    }

    /**
     * 重试耗尽：置为 {@link ResumeTaskState#EXHAUSTED}，<b>不写退避时刻</b>。
     *
     * <p><b>为什么不复用 {@link #fail} 传 {@code null} 退避</b>：{@code FAILED} 且退避为空
     * 会被 {@code listDispatchable} 当作「可立即派发」反复选中，耗尽语义形同虚设。
     * 独立的 exhausted 状态让「已达上限」在 SQL 层可查询、不再自动派发。</p>
     */
    public void exhaustRetries(String reason) {
        this.state = ResumeTaskState.EXHAUSTED;
        this.errorReason = reason == null ? "恢复重试已达上限" : reason;
        this.nextAttemptAt = null;
        this.updatedAt = Instant.now();
    }

    /**
     * 标记需人工处理：置为 {@link ResumeTaskState#NEEDS_MANUAL}，禁止自动重跑。
     *
     * <p>用于启动分流遗留 CLAIMED 时无法证明未跨恢复边界的情形 —— 领取代际之外的状态已被
     * 改变，自动重跑会让同一段恢复执行两次，只能交给人工确认。</p>
     */
    public void flagForManual(String reason) {
        this.state = ResumeTaskState.NEEDS_MANUAL;
        this.errorReason = reason == null ? "需人工确认是否已产生副作用" : reason;
        this.nextAttemptAt = null;
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

    /** 尝试次数是否已达上限；达上限后不再自动重试，交由用户手工触发恢复。 */
    public boolean exhausted(int maxAttempts) {
        return attempts >= maxAttempts;
    }
}

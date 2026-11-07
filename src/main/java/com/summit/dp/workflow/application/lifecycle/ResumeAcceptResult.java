package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

/**
 * 一次恢复请求的处置结论。
 *
 * <p><b>为什么不统一回「已受理」</b>：恢复可能因为还有别的卡片没处理而根本不发生，
 * 也可能只是进了队列。全部显示成「正在恢复」会让用户在恢复根本没发生时一直等下去。</p>
 */
public final class ResumeAcceptResult {

    /** 本次请求的走向。 */
    public enum ResumeOutcome {
        /** 手动恢复：已经交给 loop，{@link #resumed()} 非空。 */
        RESUMED,
        /** 已入队，等 worker 领取。 */
        QUEUED,
        /** 还有未决槽位：本次不恢复，等最后一个槽位落定时再触发。 */
        WAITING_UNRESOLVED,
        /** 执行已在运行，唤醒不丢，待其挂起释放后重放。 */
        RUNNING,
        /** 执行已终结，不会再恢复。 */
        ENDED,
        /** 门禁阻断：手动恢复要把原因回给用户，自动触发静默保持挂起。 */
        BLOCKED
    }

    private static final ResumeAcceptResult QUEUED = new ResumeAcceptResult(ResumeOutcome.QUEUED, null, null);
    private static final ResumeAcceptResult RUNNING = new ResumeAcceptResult(ResumeOutcome.RUNNING, null, null);
    private static final ResumeAcceptResult ENDED = new ResumeAcceptResult(ResumeOutcome.ENDED, null, null);

    private final ResumeOutcome outcome;
    private final String reason;
    private final Execution resumed;

    private ResumeAcceptResult(ResumeOutcome outcome, String reason, Execution resumed) {
        this.outcome = outcome;
        this.reason = reason;
        this.resumed = resumed;
    }

    /** 手动恢复已完成。 */
    public static ResumeAcceptResult resumed(Execution execution) {
        return new ResumeAcceptResult(ResumeOutcome.RESUMED, null, execution);
    }

    /** 已入队，等 worker。 */
    public static ResumeAcceptResult queued() {
        return QUEUED;
    }

    /** 还有未决槽位（审批 / 问答 / 委派等待）。 */
    public static ResumeAcceptResult waitingUnresolved() {
        return new ResumeAcceptResult(ResumeOutcome.WAITING_UNRESOLVED, null, null);
    }

    /** 执行已在运行。 */
    public static ResumeAcceptResult running() {
        return RUNNING;
    }

    /** 执行已终结。 */
    public static ResumeAcceptResult ended() {
        return ENDED;
    }

    /** 门禁或前置条件阻断，{@code reason} 是用户可读原因。 */
    public static ResumeAcceptResult blocked(String reason) {
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("恢复被拒绝必须给出原因");
        }
        return new ResumeAcceptResult(ResumeOutcome.BLOCKED, reason, null);
    }

    public ResumeOutcome outcome() {
        return outcome;
    }

    public boolean blocked() {
        return outcome == ResumeOutcome.BLOCKED;
    }

    /** 阻断原因；未阻断时为 {@code null}。 */
    public String reason() {
        return reason;
    }

    /** 已交回 loop 的执行；仅 {@link ResumeOutcome#RESUMED} 时非空。 */
    public Execution resumed() {
        return resumed;
    }
}

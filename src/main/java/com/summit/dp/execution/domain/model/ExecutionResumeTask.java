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

    public void acceptPersistedVersion(long nextVersion) {
        this.version = nextVersion;
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

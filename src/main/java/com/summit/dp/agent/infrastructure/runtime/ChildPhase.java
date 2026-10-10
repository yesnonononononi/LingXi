package com.summit.dp.agent.infrastructure.runtime;

/**
 * 子执行在父侧注册表里的存活阶段；终态不在其中（终态即从注册表移除）。
 *
 * <p>把「未结束」从「有没有线程」升级为「处于哪个阶段」：提交前已受理但未开跑、正在跑、
 * 跑完但挂起等人工审批，三者都要算「未结束」，否则根会在子执行尚未产出时提前收尾。</p>
 */
public enum ChildPhase {

    /** 已受理、尚未开跑：提交前登记，线程尚未绑定。 */
    PENDING_START,
    /** 正在跑：异步线程开跑前绑定运行线程。 */
    RUNNING,
    /** 子执行挂起（等人工审批）：保留登记，运行线程已退出（置 null）。 */
    SUSPENDED
}

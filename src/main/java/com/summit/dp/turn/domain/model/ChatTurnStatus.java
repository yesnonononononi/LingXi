package com.summit.dp.turn.domain.model;

import java.util.Locale;

/**
 * 业务轮次状态。
 *
 * <p><b>与框架 {@code ExecutionState} 的关系</b>：本枚举是**业务口径**，独立于框架状态机。
 * {@link #WAITING} 对应框架的 {@code SUSPENDED}（挂起等人工审批）；{@link #ACCEPTED}
 * 表示「业务已受理，框架执行可能尚未创建」—— 这个状态在框架里没有对应物，正是引入
 * {@code chat_turn} 的主要动机。</p>
 *
 * <p><b>权威划分</b>：本状态权威用于**展示**；框架 {@code execution.status} 权威用于**控制**
 * （能否 resume / cancel）。两者不互相替代 —— 若让业务状态机承担控制决策，一旦某个通知
 * 钩子漏触发，那次执行就再也恢复不了。</p>
 */
public enum ChatTurnStatus {

    /** 已受理：轮次已落库，框架执行可能还没创建。 */
    ACCEPTED,

    /** 执行中：框架已开始执行（onStart）。 */
    RUNNING,

    /** 等待中：对应框架 SUSPENDED，正在等人工审批或外部输入，可恢复。 */
    WAITING,

    /** 已完成。 */
    COMPLETED,

    /** 已失败（含启动前就失败、以及崩溃收尸）。 */
    FAILED,

    /** 已取消。 */
    CANCELLED;

    /** 终态判定：进入终态后状态与结束时间不再被改写。 */
    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == CANCELLED;
    }

    /** 解析持久化值；非法值返回 {@code null} 由调用方决定降级策略，不在这里抛异常。 */
    public static ChatTurnStatus of(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        try {
            return valueOf(name.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}

package com.summit.dp.shared.vo;

import java.time.Instant;

/**
 * 一次执行的轻量状态视图（bootstrap 专用）。
 *
 * <p><b>只回答「这个执行现在是什么状态、何时开始结束」</b>：不下发 {@code ExecutionSummary}
 * 里的 token / 模型 —— 那些是业务事实，权威在 {@code chat_turn}。这里刻意保持最小，
 * 避免与轮次视图出现两份统计口径。</p>
 *
 * <p><b>状态词表与实时事件一致</b>：{@code status} 是框架 {@code ExecutionState} 的枚举名
 * （{@code CREATED | RUNNING | SUSPENDED | COMPLETED | FAILED | CANCELLED}），与实时
 * {@code EXECUTION_UPDATED} 载荷里的 {@code ExecutionState(state)} 字面量同集合。前端只需
 * 一份谓词 {@code resolveExecutionTerminal(state)} 就能在「实时事件」与「bootstrap」两条路径上
 * 做同一判定（§8.1 退出路径 2）。</p>
 *
 * <p>ID 字段本身就是 {@code String}：雪花 ID 超过 JS 安全整数范围，在装配时即转字符串下发，
 * 前端无需再做 {@code String()} 归一（§8.3）。</p>
 *
 * @param executionId 框架执行 ID（字符串形式）
 * @param sessionId   执行所属会话 ID（字符串形式）
 * @param status      框架执行状态名
 * @param startedAt   开始时间；未开始为 {@code null}
 * @param completedAt 结束时间；未结束为 {@code null}
 */
public record ExecutionStateVO(
        String executionId,
        String sessionId,
        String status,
        Instant startedAt,
        Instant completedAt
) {
}

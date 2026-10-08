package com.summit.dp.shared.event;

/**
 * 业务事件名（SSE 命名事件的 {@code event:} 值）。
 *
 * <p><b>为什么单列一处</b>：前端按事件名分派处理分支，字符串一旦在两侧各写一遍，
 * 改名就会变成「后端还在发、前端已不认」的静默失效。这里是与前端约定的唯一真源，
 * 只放业务语义事件 —— 传输层信号（就绪 / 心跳）不在此列，它们由
 * {@link SseEventPublisher} 自己发出。</p>
 */
public final class BlockEventType {

    private BlockEventType() {
    }

    /**
     * 整轮快照：该轮全部块的完整列表 + 轮次状态 + 视图版本号。
     *
     * <p><b>什么时候发</b>：轮次状态边界（开始 / 挂起 / 恢复 / 终态）、用量变化、
     * 以及任何「块集合发生了结构性变化」而增量不足以表达的时刻。前端按 {@code viewVersion}
     * 整轮替换，天然幂等 —— 重复到达的旧版本被丢弃，乱序到达也不会把新内容覆盖成旧的。</p>
     */
    public static final String TURN_SNAPSHOT = "TURN_SNAPSHOT";

    /**
     * 单块增量：某个块的当前内容与状态。
     *
     * <p><b>什么时候发</b>：局部变化（工具结论落定、正文/思考增量、块状态翻转）而不必重发整轮。
     * 载荷仍是整轮的 {@code TurnViewVO}，但 {@code blocks} 只含**发生变化的那一个块**；
     * 前端按 {@code blockId} upsert。这避免了「为改一个工具状态而重发全部块」的流量浪费。</p>
     *
     * <p>⚠️ 增量与快照共用 {@code viewVersion}：同一轮里 {@code BLOCK_UPSERT} 的版本号必然
     * **不小于**它之前那次 {@code TURN_SNAPSHOT} 的版本号，前端据此外推「增量是在哪个基线之上」。</p>
     */
    public static final String BLOCK_UPSERT = "BLOCK_UPSERT";

    /**
     * 一帧业务事件的载荷：轮次视图 + 本次变化的性质。
     *
     * <p>{@code viewVersion} 语义见 {@link com.summit.dp.shared.vo.block.TurnViewVO} ——
     * 「该轮展示的更新批次号」，历史查询与 SSE 共用。前端拿到更小的批次号应丢弃。</p>
     *
     * @param sessionId  块内容的真实归属会话（子会话即子会话自身，不是路由用的根会话）
     * @param turnId     业务轮次 ID
     * @param viewVersion 该轮展示的更新批次号
     * @param view       该轮视图；{@code BLOCK_UPSERT} 时 {@code blocks} 只含变化的块
     */
    public record BlockEventPayload(
            long sessionId,
            long turnId,
            long viewVersion,
            com.summit.dp.shared.vo.block.TurnViewVO view
    ) {
    }
}

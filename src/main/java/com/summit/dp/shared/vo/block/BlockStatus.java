package com.summit.dp.shared.vo.block;

/**
 * 块的展示状态（字符串常量，落 JSON 与前端联合类型对齐）。
 *
 * <p><b>三处状态各归各的权威来源，不得互相冒充</b>：</p>
 * <ul>
 *   <li>{@code turn} 状态来自 {@code chat_turn.status}（ACCEPTED / RUNNING / WAITING / COMPLETED / FAILED / CANCELLED）——
 *       见 {@link #TURN_ACCEPTED} 等；</li>
 *   <li>思考 / 文本块状态来自**响应生命周期**（流式中 / 已完整）；</li>
 *   <li>工具块状态来自**权威工具视图**（{@code tool_call} 行 + 结果的结论）。</li>
 * </ul>
 *
 * <p>⚠️ 工具块的 {@code COMPLETED} 只表示**已收尾**，不代表成功：成功、被拒、取消、超时的结论在结果里，
 * 由 {@code ToolCallStatus}（PROMISED / REJECTED / FAILED / TIMED_OUT / CANCELLED）表达。
 * 直接把 {@code tool_call.status=completed} 解释成「成功」是错的。</p>
 */
public final class BlockStatus {
    private BlockStatus() {
    }

    // ── turn 状态（来自 chat_turn.status）──
    public static final String TURN_ACCEPTED = "ACCEPTED";
    public static final String TURN_RUNNING = "RUNNING";
    /** 等待：对应框架 SUSPENDED，可恢复。展示必须能表达它，否则前端只能等到终态才知道在等。 */
    public static final String TURN_WAITING = "WAITING";
    public static final String TURN_COMPLETED = "COMPLETED";
    public static final String TURN_FAILED = "FAILED";
    public static final String TURN_CANCELLED = "CANCELLED";

    // ── 思考 / 文本块状态（来自响应生命周期）──
    public static final String STREAMING = "STREAMING";
    public static final String COMPLETE = "COMPLETE";

    // ── 工具块状态（来自权威工具视图；携带结论，不只是生命周期）──
    public static final String TOOL_STARTED = "STARTED";
    public static final String TOOL_COMPLETED = "COMPLETED";
    public static final String TOOL_PROMISED = "PROMISED";
    public static final String TOOL_REJECTED = "REJECTED";
    public static final String TOOL_FAILED = "FAILED";
    public static final String TOOL_TIMED_OUT = "TIMED_OUT";
    public static final String TOOL_CANCELLED = "CANCELLED";
}

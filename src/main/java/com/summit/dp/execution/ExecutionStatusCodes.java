package com.summit.dp.execution;

import com.summit.core.agent.ExecutionState;

/**
 * {@code execution.status} 的 0-5 编码唯一真源。
 *
 * <p><b>编码与框架 {@link ExecutionState} 的声明序号一一对应，不可调换、不可复用。</b>
 * 换一个值等于让库里所有历史执行行的状态含义漂移，且投影侧（按值判终态）会静默判错。</p>
 *
 * <p>判定一律走本类的语义化方法，不在业务代码里裸写数字。</p>
 */
public final class ExecutionStatusCodes {

    /** 已创建，尚未开始。 */
    public static final int CREATED = 0;
    /** 运行中。 */
    public static final int RUNNING = 1;
    /** 已挂起，等待人工决策。 */
    public static final int SUSPENDED = 2;
    /** 正常完成。 */
    public static final int COMPLETED = 3;
    /** 失败结束。 */
    public static final int FAILED = 4;
    /** 取消结束。 */
    public static final int CANCELLED = 5;

    /** 终态编码起点：{@code >= 3} 即终态（COMPLETED / FAILED / CANCELLED）。 */
    public static final int TERMINAL_THRESHOLD = COMPLETED;

    private ExecutionStatusCodes() {
    }

    /** 是否为终态编码（COMPLETED / FAILED / CANCELLED）；{@code null} 视为非终态。 */
    public static boolean isTerminal(Integer status) {
        return status != null && status >= TERMINAL_THRESHOLD;
    }

    /**
     * 是否为终态执行状态（COMPLETED / FAILED / CANCELLED）；{@code null} 视为非终态。
     *
     * <p>{@code Execution#getExecutionState()} 是可空字段，裸调 {@code state.isTerminal()}
     * 会在状态缺失时抛 NPE —— 而三处调用点原来用 {@code ==} 逐值比较，null 是安全返回 false 的。
     * 这里补回这层 null 容忍，替换才是严格等价的。</p>
     */
    public static boolean isTerminalState(ExecutionState state) {
        return state != null && state.isTerminal();
    }

    /** 是否为挂起编码；{@code null} 返回 false。 */
    public static boolean isSuspended(Integer status) {
        return status != null && status == SUSPENDED;
    }

    /** 框架执行状态 → 库列编码。 */
    public static int encode(ExecutionState state) {
        return switch (state) {
            case CREATED -> CREATED;
            case RUNNING -> RUNNING;
            case SUSPENDED -> SUSPENDED;
            case COMPLETED -> COMPLETED;
            case FAILED -> FAILED;
            case CANCELLED -> CANCELLED;
        };
    }

    /**
     * 库列编码 → 框架执行状态。
     *
     * <p>与 {@link #encode(ExecutionState)} 互为逆运算，两边共用同一组常量，因此解码结果
     * 必然落在 {@link ExecutionState} 的枚举上，调用方无需再判断取值是否合法。</p>
     *
     * @throws IllegalArgumentException 编码不在 0-5 内；库里出现这样的值属于数据损坏，
     *         早失败好过让一个未知状态流进执行控制流
     */
    public static ExecutionState decode(int status) {
        return switch (status) {
            case CREATED -> ExecutionState.CREATED;
            case RUNNING -> ExecutionState.RUNNING;
            case SUSPENDED -> ExecutionState.SUSPENDED;
            case COMPLETED -> ExecutionState.COMPLETED;
            case FAILED -> ExecutionState.FAILED;
            case CANCELLED -> ExecutionState.CANCELLED;
            default -> throw new IllegalArgumentException("执行状态编码无法识别: status=" + status);
        };
    }
}

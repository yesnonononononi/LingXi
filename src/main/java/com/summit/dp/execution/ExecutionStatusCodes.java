package com.summit.dp.execution;

/** execution.status 的既有编码不能调换或复用，历史检查点与投影依赖同一口径。 */
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

    /** 是否为挂起编码；{@code null} 返回 false。 */
    public static boolean isSuspended(Integer status) {
        return status != null && status == SUSPENDED;
    }

}

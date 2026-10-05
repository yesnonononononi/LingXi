package com.summit.dp.execution.domain.model;

/**
 * 恢复任务的生命周期状态。
 *
 * <p><b>wire 值不可改</b>：进程重启时按字面量读回存量行判断能否重新派发。</p>
 */
public enum ResumeTaskState {

    /** 已受理，等待派发。 */
    READY("READY"),
    /** 已被某个 worker 领取，正在跑模型。 */
    CLAIMED("CLAIMED"),
    /** 恢复完成（执行已重新进入运行或走到终态）。 */
    SUCCEEDED("SUCCEEDED"),
    /** 恢复失败；attempts 未达上限时按 nextAttemptAt 退避后可再领。 */
    FAILED("FAILED"),
    /**
     * 作废：代际已变、执行已终结，或已确认被另一合法运行接管。
     */
    SUPERSEDED("SUPERSEDED"),
    /**
     * 重试已达上限，<b>不再自动重试</b>：无退避时刻。
     *
     * <p>与 {@link #FAILED} 分开是因为「已耗尽」必须与「退避未到点」在 SQL 层可区分 ——
     * {@code FAILED} 且 {@code nextAttemptAt} 为空反而会被 {@code listDispatchable} 反复选中，
     * 耗尽语义完全失效。本状态不进可派发集合，只等用户手工触发恢复。</p>
     */
    EXHAUSTED("EXHAUSTED"),
    /**
     * 需人工处理：无法证明恢复未跨过恢复边界，<b>禁止自动重跑</b>。
     *
     * <p>用于启动时分流遗留 CLAIMED：领取并提交 CLAIMED 后进程崩溃、但执行状态已不是挂起点
     * （可能已产生模型/工具副作用）时，自动重跑会让同一段恢复执行两次。本状态不进可派发集合。</p>
     */
    NEEDS_MANUAL("NEEDS_MANUAL");

    private final String dbValue;

    ResumeTaskState(String dbValue) {
        this.dbValue = dbValue;
    }

    public String dbValue() {
        return dbValue;
    }

    /** 未知状态按 {@link #SUPERSEDED} 处理：宁可不再恢复，也不盲目重跑一次模型。 */
    public static ResumeTaskState parse(String raw) {
        if (raw != null) {
            String normalized = raw.trim().toUpperCase(java.util.Locale.ROOT);
            for (ResumeTaskState state : values()) {
                if (state.dbValue.equals(normalized)) {
                    return state;
                }
            }
        }
        return SUPERSEDED;
    }
}

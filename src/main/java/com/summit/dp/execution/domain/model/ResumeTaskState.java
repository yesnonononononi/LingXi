package com.summit.dp.execution.domain.model;

/**
 * 恢复请求的生命周期状态。
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
    /** 启动失败已收口：执行已按失败链落终态，不再派发（无退避、不重试）。 */
    FAILED("FAILED"),
    /** 作废：代际已变、执行已终结，或已确认被另一合法运行接管。 */
    SUPERSEDED("SUPERSEDED");

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

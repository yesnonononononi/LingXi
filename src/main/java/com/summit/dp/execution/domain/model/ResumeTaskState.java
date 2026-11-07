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
    /**
     * 门禁没放行：请求<b>保留</b>下来等下一次唤醒，不当作废。
     *
     * <p>与 {@link #SUPERSEDED} 的区别是「还有没有机会」：作废意味着永久失去这次恢复，
     * 而门禁不通过往往只是「此刻还不能恢复」（自动轮次到顶、用户暂停、等待子代理）——
     * 把它烧成作废会让用户点批准后彻底失去重试入口。下次受理同一代际时会重新排回
     * {@link #READY}。</p>
     */
    DEFERRED("DEFERRED"),
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

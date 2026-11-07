package com.summit.dp.session.domain.model;

/**
 * 对外展示态的四种取值（纯派生，不落库）。
 *
 * <p>{@code NOT_COLLECTED} / {@code FAILED} 来自持久层事实；
 * {@code COLLECTED} / {@code CAPTURING} 由「快照总量是否等于实时总量」现算。</p>
 */
public enum TokenAuditDisplayState {

    /** 无快照：旧会话、事件丢失，或从未跑完一轮。 */
    NOT_COLLECTED,
    /** 有快照但与实时总量不一致：执行进行中、又涨了，或刚终结还没采到。 */
    CAPTURING,
    /** 有快照且与实时总量对得齐，分项就是当前上下文。 */
    COLLECTED,
    /** 最近一次采集转换或落库失败。 */
    FAILED
}

package com.summit.dp.device.domain;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 动作幂等台账。
 *
 * <p>真实世界的副作用不可撤销：重复点一次「确认转账」就是事故，不是缺陷单。所以同一个
 * actionId 从下发那一刻起就永久占位——无论是执行成功（EXECUTED），还是断线期间没拿到结果
 * （UNKNOWN），都不允许再执行第二次。</p>
 */
public class ActionLedger {

    /** 动作在台账里的生命周期。UNKNOWN 只增不减：断线时无法确认到底点没点，宁可当"点过"。 */
    public enum State { SENT, EXECUTED, UNKNOWN }

    private final Map<String, State> states = new ConcurrentHashMap<>();

    /**
     * 登记一次下发。返回 false 表示这是重放，调用方必须放弃执行。
     */
    public boolean markSent(String actionId) {
        if (actionId == null || actionId.isBlank()) {
            throw new IllegalArgumentException("动作标识不能为空");
        }
        return states.putIfAbsent(actionId, State.SENT) == null;
    }

    /** 标记执行成功；返回 true 表示这次确实是由本次调用推进到终态的。 */
    public boolean markExecuted(String actionId) {
        State previous = states.put(actionId, State.EXECUTED);
        return previous == null || previous == State.SENT;
    }

    /**
     * 标记为未确认。已 EXECUTED 的不降级——"执行成功过"比"后来断线了"更可信，
     * 降级只会让调用方去做多余的重新观察。
     */
    public void markUnknown(String actionId) {
        states.computeIfPresent(actionId, (id, state) -> state == State.EXECUTED ? state : State.UNKNOWN);
    }

    /** 连接断开：在途动作全部标记未确认，且永不回放。 */
    public void markAllPendingUnknown() {
        states.replaceAll((id, state) -> state == State.SENT ? State.UNKNOWN : state);
    }

    /** 该 actionId 是否已占用（含未确认）。占用即不得再次执行。 */
    public boolean isDuplicate(String actionId) {
        return states.containsKey(actionId);
    }

    /** 仅供诊断与测试读取，业务判断一律用 {@link #isDuplicate(String)}。 */
    public State stateOf(String actionId) {
        return states.get(actionId);
    }

    public int size() {
        return states.size();
    }
}

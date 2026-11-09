package com.summit.dp.device.domain;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 动作幂等台账。
 *
 * <p>真实世界的副作用不可撤销：重复点一次「确认转账」就是事故，不是缺陷单。所以同一个
 * actionId 从下发那一刻起就永久占位——无论是执行成功（EXECUTED），还是断线期间没拿到结果
 * （UNKNOWN），都不允许再执行第二次。</p>
 *
 * <p><b>为什么每条记录都带 deviceId</b>：动作是"在某台设备上"发生的。早先版本只按 actionId
 * 记账，导致一台设备断线时把另一台设备的在途动作也标成 UNKNOWN。单设备时看不出问题，
 * 多设备时会让 agent 对着仍然连线的设备做多余的重新观察，甚至误判"操作可能已生效"。
 * 现在清理接口按设备过滤，不再误伤。</p>
 */
public class ActionLedger {

    /** 动作在台账里的生命周期。UNKNOWN 只增不减：断线时无法确认到底点没点，宁可当"点过"。 */
    public enum State { SENT, EXECUTED, UNKNOWN }

    /** 台账条目：状态 + 归属设备。设备维度是清理时分流用的，业务判断仍只看状态。 */
    public record Entry(String deviceId, State state) {
    }

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    /**
     * 登记一次下发。返回 false 表示这是重放，调用方必须放弃执行。
     *
     * @param actionId 动作唯一标识
     * @param deviceId 该动作下发到哪台设备；用于断线/急停时按设备清理
     */
    public boolean markSent(String actionId, String deviceId) {
        if (actionId == null || actionId.isBlank()) {
            throw new IllegalArgumentException("动作标识不能为空");
        }
        if (deviceId == null || deviceId.isBlank()) {
            throw new IllegalArgumentException("设备标识不能为空");
        }
        return entries.putIfAbsent(actionId, new Entry(deviceId, State.SENT)) == null;
    }

    /** 标记执行成功；返回 true 表示这次确实是由本次调用推进到终态的。 */
    public boolean markExecuted(String actionId) {
        Entry previous = entries.put(actionId, new Entry(deviceOf(actionId), State.EXECUTED));
        return previous == null || previous.state() == State.SENT;
    }

    /**
     * 标记为未确认。已 EXECUTED 的不降级——"执行成功过"比"后来断线了"更可信，
     * 降级只会让调用方去做多余的重新观察。
     */
    public void markUnknown(String actionId) {
        entries.computeIfPresent(actionId, (id, entry) ->
                entry.state() == State.EXECUTED ? entry : new Entry(entry.deviceId(), State.UNKNOWN));
    }

    /**
     * 某台设备的在途动作全部标记未确认，且永不回放。
     *
     * <p>只影响该设备。其他设备上的 SENT 保持原样——它们的连接还在，
     * 结果仍可能正常返回，提前标 UNKNOWN 会凭空制造一次重复观察。</p>
     */
    public void markPendingUnknownOf(String deviceId) {
        if (deviceId == null || deviceId.isBlank()) {
            return;
        }
        entries.replaceAll((id, entry) -> entry.deviceId().equals(deviceId) && entry.state() == State.SENT
                ? new Entry(entry.deviceId(), State.UNKNOWN)
                : entry);
    }

    /**
     * 全部在途动作标记未确认。
     *
     * <p>仅适用于"所有设备都已失联"的全局场景。按单台设备清理请用
     * {@link #markPendingUnknownOf(String)}。</p>
     */
    public void markAllPendingUnknown() {
        entries.replaceAll((id, entry) -> entry.state() == State.SENT
                ? new Entry(entry.deviceId(), State.UNKNOWN)
                : entry);
    }

    /** 该 actionId 是否已占用（含未确认）。占用即不得再次执行。 */
    public boolean isDuplicate(String actionId) {
        return entries.containsKey(actionId);
    }

    /** 仅供诊断与测试读取，业务判断一律用 {@link #isDuplicate(String)}。 */
    public State stateOf(String actionId) {
        Entry entry = entries.get(actionId);
        return entry == null ? null : entry.state();
    }

    /** 该动作归属的设备；未登记返回 null。 */
    public String deviceOf(String actionId) {
        Entry entry = entries.get(actionId);
        return entry == null ? null : entry.deviceId();
    }

    public int size() {
        return entries.size();
    }
}


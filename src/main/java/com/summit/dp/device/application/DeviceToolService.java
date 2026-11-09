package com.summit.dp.device.application;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.domain.DangerVerdict;
import lombok.extern.slf4j.Slf4j;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 设备工具的编排层：把 agent 的一次意图翻译成"观察 / 动作 / 确认 / 急停"。
 *
 * <p>三条规则在这里落地，而不是散在工具类里：</p>
 * <ol>
 *   <li>危险动作一律先确认：命中策略就挂起，绝不"先点了再说"。</li>
 *   <li>动作幂等：同一 actionId 只执行一次，重放直接拒绝。</li>
 *   <li>失败必带原因：agent 拿不到原因就只能瞎重试，而瞎重试在真机上等于乱点。</li>
 * </ol>
 */
@Slf4j
public class DeviceToolService {

    private final DeviceRegistry registry;
    private final DangerPolicy dangerPolicy;
    private final ActionLedger ledger;
    private final Map<String, PendingAction> pending = new ConcurrentHashMap<>();

    public DeviceToolService(DeviceRegistry registry, DangerPolicy dangerPolicy, ActionLedger ledger) {
        this.registry = registry;
        this.dangerPolicy = dangerPolicy;
        this.ledger = ledger;
    }

    /** 观察并渲染成给模型看的文本。 */
    public String observe(String deviceId, int maxNodes) {
        DeviceChannel channel = registry.require(deviceId);
        try {
            String text = channel.observe(maxNodes).toPromptText();
            log.info("设备观察: deviceId={}, maxNodes={}", channel.device().deviceId(), maxNodes);
            return text;
        } catch (DeviceUnavailableException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("设备观察失败: deviceId={}, reason={}", channel.device().deviceId(), e.getMessage());
            throw new DeviceUnavailableException("观察失败: " + e.getMessage(), e);
        }
    }

    /**
     * 执行动作。命中危险策略时返回"待确认"提示，并把动作挂起等 {@link #confirm}。
     */
    public String act(String deviceId, ActionRequest request) {
        DeviceChannel channel = registry.require(deviceId);

        if (ledger.isDuplicate(request.actionId())) {
            log.warn("动作重放被拒: actionId={}, state={}", request.actionId(), ledger.stateOf(request.actionId()));
            return "该动作已执行过，不会重复执行。actionId=" + request.actionId()
                    + "。请重新观察界面确认当前状态。";
        }

        Optional<DangerVerdict> verdict = dangerPolicy.inspect(
                channel.foregroundPackage(),
                request.targetTextOrParam(),
                request.kind());
        if (verdict.isPresent()) {
            String dangerId = "d-" + UUID.randomUUID().toString().substring(0, 8);
            pending.put(dangerId, new PendingAction(dangerId, deviceId, request, verdict.get()));
            log.info("危险动作待确认: dangerId={}, actionId={}, risk={}, reason={}",
                    dangerId, request.actionId(), verdict.get().risk(), verdict.get().reason());
            return "需要用户确认后才能执行。dangerId=" + dangerId
                    + " risk=" + verdict.get().risk()
                    + " reason=" + verdict.get().reason()
                    + " action=" + request.kind() + " actionId=" + request.actionId()
                    + "。请调用 device_confirm(dangerId=\"" + dangerId + "\", approved=true|false) 并把结果如实告知用户。";
        }

        return execute(channel, request);
    }

    /** 用户对危险动作的答复。approved=true 才真正下发，且整个流程只可能执行一次。 */
    public String confirm(String dangerId, boolean approved) {
        if (dangerId == null || dangerId.isBlank()) {
            return "确认失败: dangerId 不能为空";
        }
        PendingAction action = pending.remove(dangerId);
        if (action == null) {
            return "确认失败: 找不到待确认动作 " + dangerId + "（可能已处理或已过期），请重新观察后再决策";
        }
        if (!approved) {
            ledger.markExecuted(action.request().actionId());
            log.info("危险动作被拒: dangerId={}, actionId={}", dangerId, action.request().actionId());
            return "用户已拒绝该动作，未执行。actionId=" + action.request().actionId();
        }

        DeviceChannel channel = registry.require(action.deviceId());
        log.info("危险动作已确认: dangerId={}, actionId={}", dangerId, action.request().actionId());
        return execute(channel, action.request());
    }

    /** 急停：取消该设备的未执行动作并清空它的待确认队列。 */
    public String stop(String deviceId) {
        DeviceChannel channel = registry.require(deviceId);
        StopResult result = channel.stop();
        int cleared = countPendingOf(deviceId);
        pending.values().removeIf(action -> action.deviceId().equals(deviceId));
        ledger.markPendingUnknownOf(deviceId);
        log.info("设备急停: deviceId={}, acknowledged={}, 本地清理待确认={}",
                channel.device().deviceId(), result.acknowledged(), cleared);
        // 本地已取消，但设备是否真停住以设备确认为准：未确认时必须说清，不能让人以为停住了
        return result.toPromptText() + " 本地已取消待确认动作 " + cleared + " 项。";
    }

    /** 连接断开：该设备的在途动作标未确认，永不回放；其他设备不受影响。 */
    public void onDisconnected(String deviceId) {
        registry.unregister(deviceId);
        pending.values().removeIf(action -> action.deviceId().equals(deviceId));
        ledger.markPendingUnknownOf(deviceId);
        log.warn("设备断开: deviceId={}", deviceId);
    }

    private int countPendingOf(String deviceId) {
        return (int) pending.values().stream()
                .filter(action -> action.deviceId().equals(deviceId))
                .count();
    }

    private String execute(DeviceChannel channel, ActionRequest request) {
        if (!ledger.markSent(request.actionId(), channel.device().deviceId())) {
            return "该动作已执行过，不会重复执行。actionId=" + request.actionId();
        }
        try {
            ActionOutcome outcome = channel.perform(request);
            if (outcome.ok()) {
                ledger.markExecuted(request.actionId());
            } else {
                ledger.markUnknown(request.actionId());
            }
            log.info("设备动作: actionId={}, kind={}, ok={}", request.actionId(), request.kind(), outcome.ok());
            return outcome.toPromptText();
        } catch (RuntimeException e) {
            // 异常时无法确定动作到底执行了没有：按"可能已执行"处理，宁可让 agent 重新观察
            ledger.markUnknown(request.actionId());
            log.warn("设备动作异常: actionId={}, kind={}, reason={}", request.actionId(), request.kind(), e.getMessage());
            return "failed action=" + request.actionId() + " code=UNKNOWN reason=" + e.getMessage();
        }
    }

    /** 待确认动作。 */
    private record PendingAction(String dangerId, String deviceId, ActionRequest request, DangerVerdict verdict) {
    }
}

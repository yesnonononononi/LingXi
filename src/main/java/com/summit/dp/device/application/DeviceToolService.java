package com.summit.dp.device.application;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.CoordinateScale;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.domain.DangerVerdict;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
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

    /**
     * 每台设备最近一次截图（图片像素尺寸）。
     *
     * <p>模型说"图上 (300,900)"时，必须有分母才能换算。这个缓存就是那个分母，
     * 它和 expectFrameHash 是同一份上下文里的东西：帧没变，说明模型看的还是这张图。</p>
     */
    private final Map<String, ImageSize> lastScreenshot = new ConcurrentHashMap<>();

    /**
     * 最近一次观察时节点树为空的设备。
     *
     * <p>用来给动作回执加一句"changed 不可信"：树为空时设备侧的变化检测退化，
     * 而 agent 只会照着 changed 下结论。</p>
     */
    private final Set<String> treeEmptyDevices = ConcurrentHashMap.newKeySet();

    public DeviceToolService(DeviceRegistry registry, DangerPolicy dangerPolicy, ActionLedger ledger) {
        this.registry = registry;
        this.dangerPolicy = dangerPolicy;
        this.ledger = ledger;
    }

    /**
     * 观察当前界面，返回领域快照；渲染成模型可读文本由工具层负责。
     *
     * <p>返回快照而不是字符串：截图字节、坐标空间判定、节点列表都属于"事实"，
     * 渲染成文本是展示层的事。把两者混在服务里，就没法在不解析字符串的情况下拿到截图去注入模型。</p>
     */
    public ObserveSnapshot observe(String deviceId, ObserveRequest request) {
        DeviceChannel channel = registry.require(deviceId);
        try {
            ObserveSnapshot snapshot = channel.observe(request);
            if (snapshot.emptyTree()) {
                treeEmptyDevices.add(channel.device().deviceId());
            } else {
                treeEmptyDevices.remove(channel.device().deviceId());
            }
            if (snapshot.screenshot() != null && snapshot.screenshot().hasImageSize()) {
                // 记下分母：模型随后说"图上像素"时用它换算，避免让模型自己做除法
                lastScreenshot.put(channel.device().deviceId(),
                        new ImageSize(snapshot.screenshot().width(), snapshot.screenshot().height()));
            }
            log.info("设备观察: deviceId={}, mode={}, maxNodes={}, nodes={}, screenshot={}",
                    channel.device().deviceId(), request.mode().wire(), request.maxNodes(),
                    snapshot.elements().size(), snapshot.screenshot() == null ? "无" : "有");
            return snapshot;
        } catch (DeviceUnavailableException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("设备观察失败: deviceId={}, reason={}", channel.device().deviceId(), e.getMessage());
            throw new DeviceUnavailableException("观察失败: " + e.getMessage(), e);
        }
    }

    /** 只要节点的常见情形。 */
    public ObserveSnapshot observe(String deviceId, int maxNodes) {
        return observe(deviceId, ObserveRequest.nodes(maxNodes));
    }

    /**
     * 执行动作。命中危险策略时返回"待确认"提示，并把动作挂起等 {@link #confirm}。
     */
    public String act(String deviceId, ActionRequest request) {
        DeviceChannel channel = registry.require(deviceId);
        String resolvedDeviceId = channel.device().deviceId();

        // 先把"图上像素"翻译成归一化坐标再走后面的流程：挂起的动作、幂等键、危险判定
        // 用的都必须是同一份最终参数，否则确认后执行的和用户看到的不是同一个落点。
        ActionRequest normalized;
        try {
            normalized = withNormalizedPoint(resolvedDeviceId, request);
        } catch (IllegalArgumentException e) {
            log.info("动作坐标无法确定: actionId={}, reason={}", request.actionId(), e.getMessage());
            return "动作未执行：坐标无法确定 - " + e.getMessage();
        }

        if (ledger.isDuplicate(normalized.actionId())) {
            log.warn("动作重放被拒: actionId={}, state={}", normalized.actionId(), ledger.stateOf(normalized.actionId()));
            return "该动作已执行过，不会重复执行。actionId=" + normalized.actionId()
                    + "。请重新观察界面确认当前状态。";
        }

        Optional<DangerVerdict> verdict = dangerPolicy.inspect(
                channel.foregroundPackage(),
                normalized.targetTextOrParam(),
                normalized.kind());
        if (verdict.isPresent()) {
            String dangerId = "d-" + UUID.randomUUID().toString().substring(0, 8);
            pending.put(dangerId, new PendingAction(dangerId, resolvedDeviceId, normalized, verdict.get()));
            log.info("危险动作待确认: dangerId={}, actionId={}, risk={}, reason={}",
                    dangerId, normalized.actionId(), verdict.get().risk(), verdict.get().reason());
            return "需要用户确认后才能执行。dangerId=" + dangerId
                    + " risk=" + verdict.get().risk()
                    + " reason=" + verdict.get().reason()
                    + " action=" + normalized.kind() + " actionId=" + normalized.actionId()
                    + "。请调用 device_confirm(dangerId=\"" + dangerId + "\", approved=true|false) 并把结果如实告知用户。";
        }

        return withChangeCaveat(resolvedDeviceId, execute(channel, normalized));
    }

    /**
     * 节点树为空的界面上，动作回执里的 {@code changed} 不可信。
     *
     * <p>设备侧的稳定判定只能看节点树：树恒为空时指纹恒定，于是"点了确实翻页了"也会回
     * {@code changed=false}。这是真机实测出的坑——若不提醒，agent 会以为自己没点动，
     * 然后反复重试同一个动作。</p>
     */
    private String withChangeCaveat(String deviceId, String outcome) {
        if (!treeEmptyDevices.contains(deviceId)) {
            return outcome;
        }
        return outcome + "\n[说明] 本屏节点树为空，changed 字段不可信；"
                + "请用 device_observe(mode=\"both\") 观察两次并对比截图确认界面是否变化。";
    }

    /**
     * 把 {@code params.imagePoint}（以**上一张截图**的像素为单位）翻译成归一化 {@code point}。
     *
     * <p>为什么由代码做这件事：模型看图能给出 (300, 900) 这样的像素点，但它算
     * 300/727*1000 这类除法的错误率远高于"点错位置"本身。这是确定性整数算术，属于代码职责。</p>
     *
     * <p>三种拒绝都必须说清楚：没有图（先观察）、两种坐标同时给（不猜）、动作不支持
     * （滑动需要两个点，用归一化更省事）。含糊的拒绝只会换来反复重试。</p>
     */
    private ActionRequest withNormalizedPoint(String deviceId, ActionRequest request) {
        Object raw = request.params().get("imagePoint");
        if (raw == null) {
            return request;
        }
        if (request.params().containsKey("point")) {
            throw new IllegalArgumentException("point 与 imagePoint 只能给一个");
        }
        String kind = request.kind();
        if (!"tap".equals(kind) && !"long_press".equals(kind)) {
            throw new IllegalArgumentException("imagePoint 只支持 tap / long_press，当前 kind=" + kind);
        }
        ImageSize size = lastScreenshot.get(deviceId);
        if (size == null) {
            throw new IllegalArgumentException(
                    "还没有带尺寸的截图，无法把图上像素换算成坐标；请先 device_observe(mode=\"both\")");
        }
        Map<?, ?> point = asMap(raw);
        int x = asInt(point, "x");
        int y = asInt(point, "y");
        Map<String, Object> params = new LinkedHashMap<>(request.params());
        params.remove("imagePoint");
        params.put("point", Map.of(
                "x", CoordinateScale.toNormalized(x, size.width()),
                "y", CoordinateScale.toNormalized(y, size.height())));
        return new ActionRequest(request.actionId(), kind, params, request.expectFrameHash(), request.targetText());
    }

    private static Map<?, ?> asMap(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("imagePoint 必须是 {x, y} 对象");
        }
        return map;
    }

    private static int asInt(Map<?, ?> point, String key) {
        Object value = point.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("imagePoint." + key + " 必须是整数");
        }
        return number.intValue();
    }

    /** 截图像素尺寸。 */
    private record ImageSize(int width, int height) {
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
        return withChangeCaveat(action.deviceId(), execute(channel, action.request()));
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
        // 截图尺寸随连接一起失效：重连后那是另一块屏幕/另一次会话，留着旧分母会算错落点
        lastScreenshot.remove(deviceId);
        treeEmptyDevices.remove(deviceId);
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

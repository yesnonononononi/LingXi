package com.summit.dp.device.interfaces.ws;

import com.summit.dp.shared.exception.ClientException;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * 设备 WSS 通道配置。
 *
 * <p>超时值全部做成可调而不是写死：不同网络（本机 / Tailscale / 蜂窝）下同一台手机的
 * 一次观察耗时能差一个数量级，写死必然在某一侧误伤。</p>
 */
@ConfigurationProperties(prefix = "lingxi.device")
public class DeviceWsProperties {

    /** 通道开关：fake = 进程内假设备；ws = 真实 WSS 通道。默认 fake，保证既有行为不变。 */
    private String transport = "fake";

    /** WebSocket 端点路径。 */
    private String path = "/api/device/ws";

    /** 单次观察的最长等待。截图 + 节点树压缩在低端机上可能接近 1 秒。 */
    private Duration observeTimeout = Duration.ofSeconds(15);

    /** 单次动作的最长等待。含画面稳定判定，给得比观察宽松。 */
    private Duration actionTimeout = Duration.ofSeconds(20);

    /** 握手后等待 hello 的时限；超时即断开，避免只连不报的僵尸连接占坑。 */
    private Duration helloTimeout = Duration.ofSeconds(10);

    /** 心跳间隔；超过 2 倍未收到 pong 视为掉线。 */
    private Duration heartbeat = Duration.ofSeconds(5);

    /**
     * 急停等待确认的超时。
     *
     * <p>刻意比动作超时短得多：急停是安全动作，让用户在紧急情况下等 20 秒才拿到
     * "可能没停住"的回复，是帮倒忙。</p>
     */
    private Duration stopAckTimeout = Duration.ofSeconds(3);

    /**
     * 每个请求节点额外放宽的观察超时。
     *
     * <p>节点数翻倍而超时不变，是原设计里的硬缺陷：低端机渲染 120 个节点和 20 个节点
     * 耗时差一个数量级。用线性增量而不是固定值，至少不会在小请求上误杀、大请求上必然超时。</p>
     *
     * <p>注意：这个系数尚未在真机标定，属于有依据的初值，不是实测结论。</p>
     */
    private Duration observePerNode = Duration.ofMillis(20);

    /** 观察超时上限，防止节点数异常时等出一个天文数字。 */
    private Duration observeTimeoutCap = Duration.ofSeconds(60);

    public Duration getStopAckTimeout() {
        return stopAckTimeout;
    }

    public void setStopAckTimeout(Duration stopAckTimeout) {
        this.stopAckTimeout = requirePositive(stopAckTimeout, "急停确认超时");
    }

    public Duration getObservePerNode() {
        return observePerNode;
    }

    public void setObservePerNode(Duration observePerNode) {
        if (observePerNode == null || observePerNode.isNegative()) {
            throw new ClientException("每节点观察增量不能为负");
        }
        this.observePerNode = observePerNode;
    }

    public Duration getObserveTimeoutCap() {
        return observeTimeoutCap;
    }

    public void setObserveTimeoutCap(Duration observeTimeoutCap) {
        this.observeTimeoutCap = requirePositive(observeTimeoutCap, "观察超时上限");
    }

    /**
     * 按请求节点数算出本次观察的超时：基数 + 每节点增量，封顶。
     *
     * <p>做成方法而不是让调用方自己算：超时策略只该有一份，散在调用点必然会漂移。</p>
     */
    public Duration observeTimeoutFor(int maxNodes) {
        int nodes = Math.max(0, maxNodes);
        long millis = observeTimeout.toMillis() + observePerNode.toMillis() * nodes;
        long capped = Math.min(millis, observeTimeoutCap.toMillis());
        return Duration.ofMillis(capped);
    }

    /**
     * 是否允许设备主动发起指令（手机 → 电脑）。
     *
     * <p><b>默认关闭是有意的</b>：允许设备发任意 prompt，等于把电脑的命令行交给手机。
     * 这个端点能不能被外部访问，取决于监听地址与 token；但"能不能遥控电脑跑任务"
     * 必须是运维者显式打开的第二道闸，不能因为"连上了"就默认成立。</p>
     *
     * <p>关闭时回 {@code accepted=false} 并说明原因，绝不静默丢弃——
     * 否则手机端只会看到转圈。</p>
     */
    private boolean commandEnabled = false;

    public boolean isCommandEnabled() {
        return commandEnabled;
    }

    public void setCommandEnabled(boolean commandEnabled) {
        this.commandEnabled = commandEnabled;
    }

    /** 允许接入的设备数上限。当前是 1，为多设备预留。 */
    private int maxDevices = 1;

    /**
     * 接入令牌（可选）。为空表示不校验，仅适用于本机 / Tailscale 内网。
     *
     * <p>留这个口子是因为：这个端点能让一台手机被别人点着玩。默认空是为了本地开发方便，
     * 但只要端口暴露到局域网之外就必须配上，并在手机端以 {@code ?token=} 传入。</p>
     */
    private String token = "";

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token == null ? "" : token.trim();
    }

    public boolean requiresToken() {
        return !token.isEmpty();
    }

    public String getTransport() {
        return transport;
    }

    public void setTransport(String transport) {
        if (transport == null || transport.isBlank()) {
            throw new ClientException("设备通道类型不能为空");
        }
        String normalized = transport.trim().toLowerCase();
        if (!"fake".equals(normalized) && !"ws".equals(normalized)) {
            throw new ClientException("设备通道类型只能是 fake 或 ws，实际=" + transport);
        }
        this.transport = normalized;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        if (path == null || !path.startsWith("/")) {
            throw new ClientException("设备通道路径必须以 / 开头，实际=" + path);
        }
        this.path = path;
    }

    public Duration getObserveTimeout() {
        return observeTimeout;
    }

    public void setObserveTimeout(Duration observeTimeout) {
        this.observeTimeout = requirePositive(observeTimeout, "观察超时");
    }

    public Duration getActionTimeout() {
        return actionTimeout;
    }

    public void setActionTimeout(Duration actionTimeout) {
        this.actionTimeout = requirePositive(actionTimeout, "动作超时");
    }

    public Duration getHelloTimeout() {
        return helloTimeout;
    }

    public void setHelloTimeout(Duration helloTimeout) {
        this.helloTimeout = requirePositive(helloTimeout, "握手超时");
    }

    public Duration getHeartbeat() {
        return heartbeat;
    }

    public void setHeartbeat(Duration heartbeat) {
        this.heartbeat = requirePositive(heartbeat, "心跳间隔");
    }

    public int getMaxDevices() {
        return maxDevices;
    }

    public void setMaxDevices(int maxDevices) {
        if (maxDevices < 1 || maxDevices > 16) {
            throw new ClientException("设备数上限必须在 1~16 之间，实际=" + maxDevices);
        }
        this.maxDevices = maxDevices;
    }

    public boolean isFakeTransport() {
        return "fake".equals(transport);
    }

    private static Duration requirePositive(Duration value, String name) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new ClientException(name + "必须为正数");
        }
        return value;
    }
}

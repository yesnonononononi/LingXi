package com.summit.dp.device.infrastructure.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.device.interfaces.ws.SeqGuard;
import com.summit.dp.device.interfaces.ws.PendingResponses;
import com.summit.dp.device.interfaces.ws.WireMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 通过 WSS 与真实 Android 设备通信的通道实现。
 *
 * <p>它把 {@link DeviceChannel} 的同步语义（观察一次、执行一次）翻译成异步收发：
 * 发请求 → 登记 correlation → 阻塞等待 → 收到对应结果再返回。上层编排与工具定义
 * 完全不需要知道底下是进程内假设备还是真实链接。</p>
 *
 * <p><b>为什么发送要加锁</b>：{@code WebSocketSession#sendMessage} 不是线程安全的，
 * 并发写同一会话在 Tomcat 上会抛 {@code IllegalStateException: TEXT_PARTIAL_WRITING}——
 * 典型症状是"偶发发送失败"，最难排查的那一类。</p>
 */
@Slf4j
public class WsDeviceChannel implements DeviceChannel {

    private final WebSocketSession session;
    private final ObjectMapper mapper;
    private final DevicePayloadMapper payloadMapper;
    private final PendingResponses pending;
    private final SeqGuard seqGuard;
    private final DeviceWsProperties properties;

    private final AtomicLong outboundSeq = new AtomicLong(0);
    private final AtomicLong correlationCounter = new AtomicLong(0);
    private final AtomicReference<Device> device;
    private final AtomicReference<String> foregroundPackage = new AtomicReference<>(null);
    private final AtomicBoolean stopped = new AtomicBoolean(false);
    private final AtomicBoolean alive = new AtomicBoolean(true);

    public WsDeviceChannel(WebSocketSession session,
                           ObjectMapper mapper,
                           DevicePayloadMapper payloadMapper,
                           PendingResponses pending,
                           SeqGuard seqGuard,
                           DeviceWsProperties properties,
                           Device device) {
        this.session = session;
        this.mapper = mapper;
        this.payloadMapper = payloadMapper;
        this.pending = pending;
        this.seqGuard = seqGuard;
        this.properties = properties;
        this.device = new AtomicReference<>(device);
    }

    @Override
    public Device device() {
        return device.get();
    }

    @Override
    public String foregroundPackage() {
        return foregroundPackage.get();
    }

    @Override
    public ObserveSnapshot observe(int maxNodes) {
        requireAlive();
        String reqId = "ob-" + correlationCounter.incrementAndGet();
        var future = pending.register(reqId);
        try {
            send("observe", reqId, payloadMapper.observePayload(reqId, maxNodes));
            // 超时按请求节点数自适应：节点翻倍而超时不变，会让大请求必然超时
            WireMessage response = pending.await(reqId, future, properties.observeTimeoutFor(maxNodes));
            ObserveSnapshot snapshot = payloadMapper.toSnapshot(response);
            foregroundPackage.set(snapshot.focusedPackage());
            return snapshot;
        } catch (TimeoutException e) {
            throw new DeviceUnavailableException("观察超时：" + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DeviceUnavailableException("观察被中断", e);
        } catch (IllegalArgumentException e) {
            throw new DeviceUnavailableException("观察结果格式非法：" + e.getMessage(), e);
        }
    }

    @Override
    public ActionOutcome perform(ActionRequest request) {
        requireAlive();
        var future = pending.register(request.actionId());
        try {
            send("action", request.actionId(), payloadMapper.actionPayload(request));
            WireMessage response = pending.await(request.actionId(), future, properties.getActionTimeout());
            return payloadMapper.toOutcome(response);
        } catch (TimeoutException e) {
            // 超时不等于没执行：可能动作已经到了设备、结果没回来。交给上层按"未确认"处理
            throw new DeviceUnavailableException("动作结果未返回：" + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new DeviceUnavailableException("动作被中断", e);
        } catch (IllegalArgumentException e) {
            throw new DeviceUnavailableException("动作结果格式非法：" + e.getMessage(), e);
        }
    }

    /**
     * 急停。发出后等设备确认，超时则如实返回"未确认"。
     *
     * <p>为什么不用动作超时（20s）：急停是安全动作，让用户在紧急情况下等 20 秒才拿到
     * "可能没停住"的回复，是帮倒忙。用独立且更短的超时。</p>
     */
    @Override
    public StopResult stop() {
        stopped.set(true);
        String stopId = "stop-" + correlationCounter.incrementAndGet();
        var future = pending.register(stopId);
        try {
            ObjectNode payload = mapper.createObjectNode();
            // stopId 放 payload 而不是只靠信封 id：信封 id 是消息标识，不该兼职业务关联键
            payload.put("stopId", stopId);
            send("stop", stopId, payload);
            WireMessage response = pending.await(stopId, future, properties.getStopAckTimeout());
            int cleared = response.payload().path("pendingCleared").asInt(0);
            log.info("急停已确认: deviceId={}, stopId={}, cleared={}", device.get().deviceId(), stopId, cleared);
            return StopResult.acknowledged(cleared);
        } catch (TimeoutException e) {
            log.warn("急停未获确认: deviceId={}, stopId={}", device.get().deviceId(), stopId);
            return StopResult.unacknowledged("等待设备确认超时 " + properties.getStopAckTimeout().toMillis() + "ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return StopResult.unacknowledged("等待确认时被中断");
        } catch (RuntimeException e) {
            log.warn("急停未获确认: deviceId={}, reason={}", device.get().deviceId(), e.getMessage());
            return StopResult.unacknowledged(e.getMessage());
        }
    }

    /**
     * 入站消息路由。返回 false 表示这条消息该被丢弃（重复/乱序）。
     */
    public boolean handleInbound(WireMessage message) {
        if (!seqGuard.accept(message.id(), message.seq())) {
            log.debug("丢弃重复或乱序消息: type={}, id={}, seq={}", message.type(), message.id(), message.seq());
            return false;
        }
        switch (message.type()) {
            case "observe_result" -> {
                String reqId = payloadMapper.reqIdOf(message.payload());
                pending.complete(reqId, message);
            }
            case "action_result" -> {
                String actionId = payloadMapper.actionIdOf(message.payload());
                pending.complete(actionId, message);
            }
            case "pong" -> {
                // 心跳回执本身没有业务含义，seq 守卫已经顺带证明链路活着
                log.debug("设备心跳: deviceId={}", message.deviceId());
            }
            case "stop_ack" -> {
                String stopId = payloadMapper.stopIdOf(message.payload());
                if (stopId == null) {
                    log.warn("stop_ack 缺少 stopId，无法关联: deviceId={}", message.deviceId());
                } else {
                    pending.complete(stopId, message);
                }
            }
            case "error" -> {
                String relatedId = message.payload() == null ? null : message.payload().path("relatedId").asText(null);
                String msg = message.payload() == null ? "设备报错" : message.payload().path("msg").asText("设备报错");
                log.warn("设备错误: deviceId={}, relatedId={}, msg={}", message.deviceId(), relatedId, msg);
                if (relatedId != null) {
                    pending.complete(relatedId, message);
                }
            }
            default -> log.warn("收到未预期的设备消息类型: type={}, deviceId={}", message.type(), message.deviceId());
        }
        return true;
    }

    /** 连接关闭：让所有等待者立刻失败，别让线程干等到超时。 */
    public void close(String reason) {
        alive.set(false);
        pending.failAll("设备连接已关闭: " + reason);
    }

    public boolean isAlive() {
        return alive.get() && session.isOpen();
    }

    private void requireAlive() {
        if (stopped.get()) {
            throw new DeviceUnavailableException("设备已急停，需先恢复");
        }
        if (!isAlive()) {
            throw new DeviceUnavailableException("设备连接已断开");
        }
    }

    private void send(String type, String id, com.fasterxml.jackson.databind.JsonNode payload) {
        long seq = outboundSeq.incrementAndGet();
        WireMessage message = new WireMessage(
                WireMessage.SUPPORTED_VERSION,
                type,
                id,
                device.get().deviceId(),
                seq,
                System.currentTimeMillis(),
                payload);
        String text = message.text(mapper);
        try {
            synchronized (session) {
                session.sendMessage(new TextMessage(text));
            }
        } catch (IOException e) {
            alive.set(false);
            throw new DeviceUnavailableException("发送失败: " + e.getMessage(), e);
        }
    }
}

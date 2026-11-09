package com.summit.dp.device.application;

import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.Device;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 已连接设备的注册表。
 *
 * <p>当前阶段是单设备（协议里已经带 deviceId，为多设备预留）。这里仍然按 deviceId 建索引，
 * 因为"以后再改"的成本远高于现在就多写一个 Map。</p>
 */
public class DeviceRegistry {

    private final Map<String, DeviceChannel> channels = new ConcurrentHashMap<>();

    public void register(DeviceChannel channel) {
        channels.put(channel.device().deviceId(), channel);
    }

    public void unregister(String deviceId) {
        if (deviceId != null) {
            channels.remove(deviceId);
        }
    }

    public Optional<DeviceChannel> channel(String deviceId) {
        if (deviceId == null || deviceId.isBlank()) {
            return anyOnline();
        }
        return Optional.ofNullable(channels.get(deviceId));
    }

    /** 未指定设备时取唯一在线设备；多设备场景必须显式给 deviceId，否则就是"猜"。</p> */
    public Optional<DeviceChannel> anyOnline() {
        if (channels.size() == 1) {
            return Optional.of(channels.values().iterator().next());
        }
        return Optional.empty();
    }

    /** 取设备通道，取不到直接给出可读原因，避免上层各自拼错误文案。 */
    public DeviceChannel require(String deviceId) {
        return channel(deviceId).orElseThrow(() -> new DeviceUnavailableException(
                deviceId == null || deviceId.isBlank()
                        ? "当前没有已连接的设备，请先在手机端连接并使无障碍服务运行"
                        : "设备未连接: " + deviceId));
    }

    public List<Device> devices() {
        return channels.values().stream().map(DeviceChannel::device).toList();
    }

    public int size() {
        return channels.size();
    }
}

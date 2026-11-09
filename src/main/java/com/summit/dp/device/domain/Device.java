package com.summit.dp.device.domain;

import java.util.Set;

/**
 * 一台可被 agent 操控的 Android 设备。
 *
 * <p>这里只保留"决策需要知道的东西"：能力和屏幕尺寸。设备内部状态（无障碍服务是否在跑、
 * 当前前台应用）属于感知结果，不属于设备身份，混进来会让这个对象越滚越大。</p>
 */
public record Device(
        String deviceId,
        String appVersion,
        int androidSdk,
        Set<DeviceCapability> capabilities,
        DeviceScreen screen,
        long lastSeenAt
) {

    public Device {
        if (deviceId == null || deviceId.isBlank()) {
            throw new IllegalArgumentException("设备标识不能为空");
        }
        if (screen == null) {
            throw new IllegalArgumentException("设备屏幕信息不能为空");
        }
        capabilities = capabilities == null ? Set.of() : Set.copyOf(capabilities);
    }

    /** 设备是否声明了某项能力；未声明即视为不支持，不做"猜它能行"的兜底。 */
    public boolean supports(DeviceCapability capability) {
        return capabilities.contains(capability);
    }

    public Device touch(long now) {
        return new Device(deviceId, appVersion, androidSdk, capabilities, screen, now);
    }
}

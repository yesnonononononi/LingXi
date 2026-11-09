package com.summit.dp.device.domain;

import java.util.Map;
import java.util.Optional;

/**
 * 设备声明的能力。电脑端只能下发设备声明过支持的动作，
 * 未声明就下发等于让 agent 对着空气操作。
 */
public enum DeviceCapability {
    NODE_TREE("nodeTree"),
    SCREENSHOT("screenshot"),
    GESTURES("gestures"),
    SET_TEXT("setText"),
    LAUNCH_APP("launchApp"),
    NOTIFICATIONS("notifications"),
    FOREGROUND_SERVICE("foregroundService");

    private final String wire;

    DeviceCapability(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    private static final Map<String, DeviceCapability> BY_WIRE =
            java.util.Arrays.stream(values()).collect(java.util.stream.Collectors.toMap(
                    DeviceCapability::wire, capability -> capability));

    /**
     * 按协议名解析能力。
     *
     * <p>未知能力返回 empty 而不是猜一个：把"看不懂"映射成某个真实能力，等于凭空向 agent
     * 声明"我能读节点树"，随后的一条观察就会全线失败，而错误会出现在离真因很远的地方。</p>
     */
    public static Optional<DeviceCapability> fromWire(String wire) {
        return wire == null ? Optional.empty() : Optional.ofNullable(BY_WIRE.get(wire.trim()));
    }
}


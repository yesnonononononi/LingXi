package com.summit.dp.device.interfaces.tool.arguments;

import com.summit.dp.device.application.model.ObserveMode;

/**
 * device_observe 的参数。
 *
 * <p>{@code mode} 是字符串而不是枚举：Jackson 反序列化未知枚举值会抛异常，
 * 而这里希望由工具自己给出"mode 只能是 nodes/shot/both"的可读回执。</p>
 */
public record DeviceObserveArguments(
        String deviceId,
        Integer maxNodes,
        String mode
) {

    /** 解析观察模式；缺省为 nodes，未知值抛 [IllegalArgumentException] 供工具层转成可读错误。 */
    public ObserveMode resolveMode() {
        if (mode == null || mode.isBlank()) {
            return ObserveMode.NODES;
        }
        ObserveMode parsed = ObserveMode.fromWire(mode);
        if (parsed == null) {
            throw new IllegalArgumentException("mode 只能是 nodes / shot / both，实际=" + mode);
        }
        return parsed;
    }
}

package com.summit.dp.device.interfaces.tool.arguments;

/** device_observe 的参数。 */
public record DeviceObserveArguments(
        String deviceId,
        Integer maxNodes
) {
}

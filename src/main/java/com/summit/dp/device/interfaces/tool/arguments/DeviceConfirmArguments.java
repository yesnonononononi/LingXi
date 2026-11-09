package com.summit.dp.device.interfaces.tool.arguments;

/** device_confirm 的参数。 */
public record DeviceConfirmArguments(
        String dangerId,
        Boolean approved
) {
}

package com.summit.dp.device.interfaces.tool;

/**
 * 设备工具名。
 *
 * <p>单独抽成常量而不是散在各处写字面量：图片注入拦截器要按工具名判断"这条回执带图"，
 * 两处各写一遍 {@code "device_observe"}，改一个忘一个就会静默失去截图能力。</p>
 */
public final class DeviceToolNames {

    public static final String OBSERVE = "device_observe";
    public static final String ACTION = "device_action";
    public static final String CONFIRM = "device_confirm";
    public static final String STOP = "device_stop";

    private DeviceToolNames() {
    }
}

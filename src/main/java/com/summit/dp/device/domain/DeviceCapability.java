package com.summit.dp.device.domain;

/**
 * 设备声明的能力。电脑端只能下发设备声明过支持的动作，
 * 未声明就下发等于让 agent 对着空气操作。</p>
 */
public enum DeviceCapability {
    NODE_TREE,
    SCREENSHOT,
    GESTURES,
    SET_TEXT,
    LAUNCH_APP,
    NOTIFICATIONS,
    FOREGROUND_SERVICE
}

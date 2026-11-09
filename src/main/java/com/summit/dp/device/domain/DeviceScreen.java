package com.summit.dp.device.domain;

/**
 * 设备屏幕元信息。坐标全部按归一化 0~1000 交换，这里保留原始尺寸只用于换算与校验。
 */
public record DeviceScreen(int width, int height, float density, int rotation) {

    public DeviceScreen {
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("屏幕宽高必须为正数");
        }
        if (density <= 0) {
            throw new IllegalArgumentException("屏幕密度必须为正数");
        }
        if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270) {
            throw new IllegalArgumentException("屏幕旋转角度只能是 0/90/180/270，实际=" + rotation);
        }
    }
}

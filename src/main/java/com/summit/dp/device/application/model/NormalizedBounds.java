package com.summit.dp.device.application.model;

/**
 * 归一化包围盒：0~1000 网格。双端都不传物理像素，否则换分辨率就要重新训练模型的手感。
 */
public record NormalizedBounds(int x1, int y1, int x2, int y2) {

    public NormalizedBounds {
        checkInRange(x1, "x1");
        checkInRange(y1, "y1");
        checkInRange(x2, "x2");
        checkInRange(y2, "y2");
        if (x1 > x2 || y1 > y2) {
            throw new IllegalArgumentException(
                    "包围盒左上角必须不大于右下角：(" + x1 + "," + y1 + ")-(" + x2 + "," + y2 + ")");
        }
    }

    private static void checkInRange(int value, String name) {
        if (value < 0 || value > 1000) {
            throw new IllegalArgumentException(name + " 必须是 0~1000 的归一化值，实际=" + value);
        }
    }

    public int centerX() {
        return (x1 + x2) / 2;
    }

    public int centerY() {
        return (y1 + y2) / 2;
    }
}

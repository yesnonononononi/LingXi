package com.summit.dp.device.application.model;

/**
 * 图上像素 ↔ 归一化坐标的唯一换算口径（桌面侧）。
 *
 * <p><b>为什么需要它，而不是让模型自己算</b>：截图是 727x1600，模型从图上读出 (300, 900)，
 * 要换算成 0~1000 归一化坐标得算 300/727*1000 与 900/1600*1000。让大模型做两次除法，
 * 错一次就是点偏；而这是确定性的整数算术，本来就该由代码做。</p>
 *
 * <p>分母必须是**图片**尺寸：模型看到的是图，它指的像素点属于图。拿屏幕尺寸当分母，
 * 误差会随缩放比放大到肉眼可见。</p>
 */
public final class CoordinateScale {

    /** 归一化网格上界，与协议一致。 */
    public static final int MAX = 1000;

    private CoordinateScale() {
    }

    /** 像素 → 归一化，四舍五入并夹到 0~{@link #MAX}。 */
    public static int toNormalized(int pixel, int total) {
        if (total <= 0) {
            throw new IllegalArgumentException("换算分母必须为正，实际=" + total);
        }
        long scaled = Math.round((double) pixel * MAX / total);
        return (int) Math.max(0, Math.min(MAX, scaled));
    }

    /** 归一化 → 像素（主要用于回显与测试往返）。 */
    public static int toPixel(int normalized, int total) {
        if (total <= 0) {
            throw new IllegalArgumentException("换算分母必须为正，实际=" + total);
        }
        long scaled = Math.round((double) normalized * total / MAX);
        return (int) Math.max(0, Math.min(total - 1, scaled));
    }
}

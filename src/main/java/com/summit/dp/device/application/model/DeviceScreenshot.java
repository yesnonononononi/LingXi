package com.summit.dp.device.application.model;

import com.summit.dp.device.domain.DeviceScreen;

/**
 * 设备回传的一张截图。
 *
 * <p><b>三个尺寸各有各的用途，混用就点不准：</b></p>
 * <ul>
 *   <li>{@code width/height}：<b>图片</b>像素。模型在图上读出的像素点必须除以它才能变成归一化坐标，
 *       因为模型看到的是这张图，不是屏幕。</li>
 *   <li>{@code rawWidth/rawHeight}：截取时的<b>原始</b>像素（可空，老设备不传）。它是唯一能证明
 *       "图片像素空间 == 节点坐标空间"的证据。</li>
 *   <li>{@link DeviceScreen}：节点的坐标空间。原始像素与它不一致，说明两套坐标不是同一个空间，
 *       此时任何点击都会整体偏移——而症状只是"点了没反应"，事后几乎无法反推。</li>
 * </ul>
 *
 * <p>校验放在构造器里而不是解析处：一条不合法的载荷应该在进入领域的第一刻就被拒绝，
 * 而不是等到某个下游分支才发现"这图没有宽高"。</p>
 */
public record DeviceScreenshot(
        String shotRef,
        byte[] image,
        String mimeType,
        Integer width,
        Integer height,
        Integer rawWidth,
        Integer rawHeight
) {

    /** 内联字节上限，与协议一致（2MB 原始字节）。 */
    public static final int MAX_INLINE_BYTES = 2 * 1024 * 1024;

    public DeviceScreenshot {
        boolean hasRef = shotRef != null && !shotRef.isBlank();
        boolean hasBytes = image != null && image.length > 0;
        if (hasRef == hasBytes) {
            throw new IllegalArgumentException("截图必须二选一：shotRef 或内联 base64，不能同时给也不能都不给");
        }
        if (hasBytes && image.length > MAX_INLINE_BYTES) {
            throw new IllegalArgumentException(
                    "内联截图超过 " + (MAX_INLINE_BYTES / 1024) + "KB，应改为落盘后给 shotRef");
        }
        if (hasBytes) {
            // 记录类字段是可变的 byte[]：不留副本等于把内部状态交给调用方随手改
            image = image.clone();
        }
        requirePair(width, height, "width", "height",
                "截图缺少图片宽高：没有它就无法把模型在图上点的像素换算成归一化坐标");
        requirePair(rawWidth, rawHeight, "rawWidth", "rawHeight",
                "rawWidth 与 rawHeight 必须成对出现，只给一半无法判断像素空间");
        mimeType = (mimeType == null || mimeType.isBlank()) ? "image/jpeg" : mimeType.trim();
    }

    private static void requirePair(Integer first, Integer second, String firstName, String secondName,
                                    String halfPairMessage) {
        if ((first == null) != (second == null)) {
            throw new IllegalArgumentException(halfPairMessage);
        }
        if (first != null && (first <= 0 || second <= 0)) {
            throw new IllegalArgumentException(
                    "截图尺寸必须为正：" + firstName + "=" + first + ", " + secondName + "=" + second);
        }
    }

    @Override
    public byte[] image() {
        return image == null ? null : image.clone();
    }

    public String extension() {
        return "image/png".equalsIgnoreCase(mimeType) ? "png" : "jpg";
    }

    /** 是否带像素（截图落盘为引用时，本进程看不到字节，只能给出引用）。 */
    public boolean hasPixels() {
        return image != null && image.length > 0;
    }

    public boolean hasImageSize() {
        return width != null && height != null;
    }

    public boolean hasRawSize() {
        return rawWidth != null && rawHeight != null;
    }

    /**
     * 原始像素与屏幕是否同一个坐标空间。
     *
     * <p>三种答案必须区分：{@code UNKNOWN} 是老设备没上报，不是"没问题"；
     * 把未知当成匹配，等于把偏移隐患静默放过。</p>
     */
    public CoordinateSpace coordinateSpace(DeviceScreen screen) {
        if (!hasRawSize() || screen == null) {
            return CoordinateSpace.UNKNOWN;
        }
        boolean same = rawWidth == screen.width() && rawHeight == screen.height();
        // 旋转 90/270 时屏幕宽高互换是正常的，不能误报成"坐标空间不一致"
        boolean swapped = rawWidth == screen.height() && rawHeight == screen.width();
        return (same || swapped) ? CoordinateSpace.MATCH : CoordinateSpace.MISMATCH;
    }

    /** 给模型看的一行尺寸摘要；缺字段就如实缺，不编造。 */
    public String sizeText() {
        StringBuilder builder = new StringBuilder();
        builder.append(hasImageSize() ? width + "x" + height : "尺寸未知");
        if (hasRawSize()) {
            builder.append(" raw=").append(rawWidth).append('x').append(rawHeight);
        }
        builder.append(" mime=").append(mimeType);
        if (shotRef != null && !shotRef.isBlank()) {
            builder.append(" ref=").append(shotRef);
        }
        return builder.toString();
    }

    /** 截图原始像素与屏幕的关系。 */
    public enum CoordinateSpace {
        /** 同一坐标空间：像素点可以直接按比例换算。 */
        MATCH,
        /** 不同坐标空间：必须告警，否则点击会整体偏移。 */
        MISMATCH,
        /** 设备未上报原始像素（老版本），无法判断。 */
        UNKNOWN
    }
}

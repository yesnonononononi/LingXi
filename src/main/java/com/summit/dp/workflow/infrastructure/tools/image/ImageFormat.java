package com.summit.dp.workflow.infrastructure.tools.image;

import java.util.Locale;

/**
 * 允许读入的图片格式，按文件头判定。
 *
 * <p>不看扩展名：模型下发的路径经常与真实内容不符。{@code storedExtension} 是落盘扩展名，
 * 与入参格式无关 —— GIF/BMP 统一转成 PNG 保存，透明通道才不丢。</p>
 */
public enum ImageFormat {
    PNG("image/png", "png", true),
    JPEG("image/jpeg", "jpg", false),
    GIF("image/gif", "png", true),
    BMP("image/bmp", "png", true);

    private final String mimeType;
    private final String storedExtension;
    private final boolean keepsAlpha;

    ImageFormat(String mimeType, String storedExtension, boolean keepsAlpha) {
        this.mimeType = mimeType;
        this.storedExtension = storedExtension;
        this.keepsAlpha = keepsAlpha;
    }

    public String mimeType() {
        return mimeType;
    }

    public String storedExtension() {
        return storedExtension;
    }

    public boolean keepsAlpha() {
        return keepsAlpha;
    }

    /** 命中支持列表返回对应格式，否则返回 {@code null}（由调用方再区分「不是图片」与「格式不支持」）。 */
    public static ImageFormat detect(byte[] data) {
        if (data == null || data.length < 8) return null;
        if (startsWith(data, new int[]{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A})) return PNG;
        if (startsWith(data, new int[]{0xFF, 0xD8, 0xFF})) return JPEG;
        if (startsWith(data, new int[]{0x47, 0x49, 0x46, 0x38})) return GIF;
        if (startsWith(data, new int[]{0x42, 0x4D})) return BMP;
        return null;
    }

    /**
     * 能认出「是图片但当前没有解码器」的格式，用于把错误文案说清楚。
     *
     * @return {@code WEBP} / {@code AVIF/HEIC} / {@code SVG}；真不是图片返回 {@code null}
     */
    public static String unsupportedLabel(byte[] data) {
        if (data == null || data.length == 0) return null;
        if (data.length >= 12 && ascii(data, 0, 4).equals("RIFF") && ascii(data, 8, 4).equals("WEBP")) return "WEBP";
        if (data.length >= 12 && ascii(data, 4, 4).equals("ftyp")) {
            String brand = ascii(data, 8, 4).toLowerCase(Locale.ROOT);
            if (brand.startsWith("avi")) return "AVIF/HEIC";
            if (brand.startsWith("hei") || brand.startsWith("mif1")) return "AVIF/HEIC";
        }
        String head = ascii(data, 0, Math.min(data.length, 16)).trim().toLowerCase(Locale.ROOT);
        if (head.startsWith("<svg") || head.startsWith("<?xml")) return "SVG";
        return null;
    }

    private static boolean startsWith(byte[] data, int[] prefix) {
        if (data.length < prefix.length) return false;
        for (int index = 0; index < prefix.length; index++) {
            if ((data[index] & 0xFF) != prefix[index]) return false;
        }
        return true;
    }

    private static String ascii(byte[] data, int offset, int length) {
        int end = Math.min(offset + length, data.length);
        StringBuilder text = new StringBuilder();
        for (int index = offset; index < end; index++) {
            text.append((char) (data[index] & 0xFF));
        }
        return text.toString();
    }
}

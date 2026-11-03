package com.summit.dp.workflow.infrastructure.tools.image;

import java.awt.image.BufferedImage;

/** 像素级判定：蒙版校验与生图结果校验都要扫 alpha 通道。 */
final class ImagePixels {

    private ImagePixels() {
    }

    /** 是否至少有一个完全透明（alpha 为 0）的像素。 */
    static boolean hasFullyTransparentPixel(BufferedImage image) {
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) >>> 24) == 0) return true;
            }
        }
        return false;
    }

    /** 是否所有像素都完全不透明；半透明也算不满足，调用方要的是「不透明背景」。 */
    static boolean isFullyOpaque(BufferedImage image) {
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) >>> 24) != 255) return false;
            }
        }
        return true;
    }
}

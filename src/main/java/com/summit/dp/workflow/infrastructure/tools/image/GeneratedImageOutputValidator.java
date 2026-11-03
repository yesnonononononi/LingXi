package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.model.image.ImageGenerationOptions;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** 显式输出要求按模型原始结果验收，转格式不能代替服务端满足要求。 */
public class GeneratedImageOutputValidator {
    public void validate(byte[] bytes, ImageFormat format, ImageGenerationOptions options) throws IOException {
        if (options == null) return;
        ImageToolChecks.rejectIf(options.outputFormat() != null
                        && !(format == ImageFormat.PNG ? "png" : "jpeg").equals(options.outputFormat()),
                "生图服务未按要求返回 " + options.outputFormat() + " 格式，请检查模型和服务端是否支持");
        boolean requiresTransparency = "transparent".equals(options.background());
        if (!requiresTransparency && !"opaque".equals(options.background())) return;
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
        ImageToolChecks.rejectIf(image == null, "生图结果无法解码，请检查服务端返回的图片");
        ImageToolChecks.rejectIf(requiresTransparency && !image.getColorModel().hasAlpha(),
                "生图服务未返回带 alpha 通道的透明图片");
        if (requiresTransparency) {
            ImageToolChecks.rejectIf(!ImagePixels.hasFullyTransparentPixel(image),
                    "生图结果没有实际透明像素，服务端未满足透明背景要求");
            return;
        }
        requireNoTranslucentPixel(image);
    }

    /** 不透明要求与透明要求是两套语义：这里连半透明都算服务端没照做，不能并入透明判定。 */
    private void requireNoTranslucentPixel(BufferedImage image) {
        if (!image.getColorModel().hasAlpha()) return;
        ImageToolChecks.rejectIf(!ImagePixels.isFullyOpaque(image),
                "生图结果仍包含透明或半透明像素，服务端未满足不透明背景要求");
    }
}

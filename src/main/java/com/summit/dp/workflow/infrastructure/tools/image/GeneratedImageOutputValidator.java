package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.dp.shared.exception.ClientException;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** 显式输出要求按模型原始结果验收，转格式不能代替服务端满足要求。 */
public class GeneratedImageOutputValidator {
    public void validate(byte[] bytes, ImageFormat format, ImageGenerationOptions options) throws IOException {
        if (options == null) return;
        throwIf(options.outputFormat() != null && !(format == ImageFormat.PNG ? "png" : "jpeg").equals(options.outputFormat()),
                "生图服务未按要求返回 " + options.outputFormat() + " 格式，请检查模型和服务端是否支持");
        if (!"transparent".equals(options.background()) && !"opaque".equals(options.background())) return;
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
        throwIf(image == null, "生图结果无法解码，请检查服务端返回的图片");
        boolean requiresTransparency = "transparent".equals(options.background());
        throwIf(requiresTransparency && !image.getColorModel().hasAlpha(), "生图服务未返回带 alpha 通道的透明图片");
        if (!requiresTransparency && !image.getColorModel().hasAlpha()) return;
        boolean transparent = false;
        for (int y = 0; y < image.getHeight() && !transparent; y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                int alpha = image.getRGB(x, y) >>> 24;
                throwIf(!requiresTransparency && alpha < 255, "生图结果仍包含透明或半透明像素，服务端未满足不透明背景要求");
                if (requiresTransparency && alpha == 0) {
                    transparent = true;
                    break;
                }
            }
        }
        throwIf(requiresTransparency && !transparent, "生图结果没有实际透明像素，服务端未满足透明背景要求");
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

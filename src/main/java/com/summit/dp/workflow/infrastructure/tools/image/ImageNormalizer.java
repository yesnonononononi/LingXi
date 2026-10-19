package com.summit.dp.workflow.infrastructure.tools.image;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Iterator;

/**
 * 图片尺寸探测、缩放与重编码。
 *
 * <p>只依赖 JDK 自带的 ImageIO，不引第三方图像库。尺寸上限先于完整解码校验，
 * 否则一张解压炸弹就能把堆打穿。</p>
 */
public class ImageNormalizer {

    /** 长边上限：视觉模型在这个尺寸附近基本不丢细节，再大只是烧 token。 */
    public static final int MAX_LONG_EDGE = 1568;
    /** 像素上限（约 7300×5500）：先读宽高再决定要不要解码。 */
    public static final long MAX_PIXELS = 40_000_000L;

    private static final float JPEG_QUALITY = 0.85f;
    private static final String JPEG = "jpg";
    private static final String PNG = "png";

    /** 只读文件头拿尺寸，不解码像素数据。 */
    public ImageSize probe(byte[] data) throws IOException {
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(data))) {
            if (input == null) throw new IOException("图片数据无法读取");
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new IOException("没有可用的图片解码器");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                return new ImageSize(reader.getWidth(0), reader.getHeight(0));
            } finally {
                reader.dispose();
            }
        }
    }

    /**
     * 规整成模型可接受的形态：长边超限则等比缩小，GIF/BMP 转 PNG，JPEG 重压。
     *
     * <p>未超限的 PNG/JPEG 原样返回，不做无意义的重编码（重编码只会掉画质）。</p>
     */
    public NormalizedImage normalize(byte[] data, ImageFormat format) throws IOException {
        ImageSize size = probe(data);
        if (size.width() <= 0 || size.height() <= 0 || (long) size.width() * size.height() > MAX_PIXELS) {
            throw new IOException("图片像素过大或尺寸无效");
        }
        boolean needsScale = Math.max(size.width(), size.height()) > MAX_LONG_EDGE;
        boolean needsConvert = format == ImageFormat.GIF || format == ImageFormat.BMP;
        // 尺寸头可读不代表像素完整，未缩放的图片也须验证解码，避免坏图拖垮模型请求。
        BufferedImage source = ImageIO.read(new ByteArrayInputStream(data));
        if (source == null) throw new IOException("图片解码失败");
        if (!needsScale && !needsConvert) {
            return new NormalizedImage(data, format.mimeType(), format.storedExtension(), size.width(), size.height());
        }

        ImageSize target = fit(size.width(), size.height());
        BufferedImage canvas = draw(source, target, format.keepsAlpha());
        if (format.keepsAlpha()) {
            return new NormalizedImage(encode(canvas, PNG), ImageFormat.PNG.mimeType(), PNG, target.width(), target.height());
        }
        return new NormalizedImage(encode(canvas, JPEG), format.mimeType(), JPEG, target.width(), target.height());
    }

    private ImageSize fit(int width, int height) {
        int longEdge = Math.max(width, height);
        if (longEdge <= MAX_LONG_EDGE) return new ImageSize(width, height);
        double ratio = (double) MAX_LONG_EDGE / longEdge;
        int targetWidth = Math.max(1, (int) Math.round(width * ratio));
        int targetHeight = Math.max(1, (int) Math.round(height * ratio));
        return new ImageSize(targetWidth, targetHeight);
    }

    private BufferedImage draw(BufferedImage source, ImageSize target, boolean keepAlpha) {
        // JPEG 不支持透明：先铺白底，否则透明区会被画成黑块。
        int type = keepAlpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB;
        BufferedImage canvas = new BufferedImage(target.width(), target.height(), type);
        Graphics2D graphics = canvas.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            if (!keepAlpha) {
                graphics.setColor(Color.WHITE);
                graphics.fillRect(0, 0, target.width(), target.height());
            }
            graphics.drawImage(source, 0, 0, target.width(), target.height(), null);
        } finally {
            graphics.dispose();
        }
        return canvas;
    }

    private byte[] encode(BufferedImage image, String formatName) throws IOException {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName(formatName);
        if (!writers.hasNext()) throw new IOException("没有可用的图片编码器: " + formatName);
        ImageWriter writer = writers.next();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ImageOutputStream stream = ImageIO.createImageOutputStream(output)) {
            writer.setOutput(stream);
            ImageWriteParam param = writer.getDefaultWriteParam();
            if (JPEG.equals(formatName) && param.canWriteCompressed()) {
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(JPEG_QUALITY);
            }
            writer.write(null, new IIOImage(image, null, null), param);
        } finally {
            writer.dispose();
        }
        return output.toByteArray();
    }

    /** 图片像素尺寸。 */
    public record ImageSize(int width, int height) {
    }

    /** 规整结果：{@code mimeType}/{@code extension} 描述的是这里产出的字节，不是入参格式。 */
    public record NormalizedImage(byte[] data, String mimeType, String extension, int width, int height) {
    }
}

package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Image;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** 润色依赖原图细节，不沿用看图流程的缩放与重编码。 */
@Component
public class ReferenceImageLoader {
    static final int MAX_BYTES = 16 * 1024 * 1024;
    static final int MAX_REFERENCES = 16;
    private static final int MAX_TOTAL_BYTES = 64 * 1024 * 1024;
    private final ImageNormalizer normalizer = new ImageNormalizer();

    public List<Image> loadReferences(JsonNode args, Workspace workspace) throws IOException {
        if (!args.has("reference_image_paths")) {
            return args.has("reference_image_path")
                    ? List.of(readSource(args.path("reference_image_path"), workspace).toImage())
                    : List.of();
        }
        ImageToolChecks.rejectIf(args.has("reference_image_path"), "reference_image_path 和 reference_image_paths 只能传一个");
        JsonNode paths = args.path("reference_image_paths");
        ImageToolChecks.rejectIf(!paths.isArray() || paths.isEmpty() || paths.size() > MAX_REFERENCES,
                "reference_image_paths 必须是包含 1 至 16 个文件路径的数组");
        List<Image> images = new ArrayList<>(paths.size());
        int totalBytes = 0;
        for (JsonNode path : paths) {
            LoadedImage source = readSource(path, workspace);
            totalBytes += source.bytes().length;
            // 同一次请求会同时持有 Base64 和上传字节，限制多图总大小。
            ImageToolChecks.rejectIf(totalBytes > MAX_TOTAL_BYTES, "多张参考图合计不能超过 64MB");
            images.add(source.toImage());
        }
        return List.copyOf(images);
    }

    public Image loadMask(JsonNode args, Workspace workspace, Image reference) throws IOException {
        if (!args.has("mask_image_path")) return null;
        ImageToolChecks.rejectIf(reference == null, "使用蒙版 mask_image_path 时必须同时提供参考图");
        LoadedImage mask = readSource(args.path("mask_image_path"), workspace);
        ImageToolChecks.rejectIf(mask.format() != ImageFormat.PNG, "蒙版必须为带透明区域的 PNG 图片");
        ImageNormalizer.ImageSize original = normalizer.probe(Base64.getDecoder().decode(reference.getBase64Data()));
        BufferedImage decoded = ImageIO.read(new ByteArrayInputStream(mask.bytes()));
        ImageToolChecks.rejectIf(decoded.getWidth() != original.width() || decoded.getHeight() != original.height(),
                "蒙版尺寸必须与第一张参考图完全一致");
        ImageToolChecks.rejectIf(!decoded.getColorModel().hasAlpha(), "蒙版必须包含 alpha 通道和完全透明的待编辑区域");
        ImageToolChecks.rejectIf(!ImagePixels.hasFullyTransparentPixel(decoded),
                "蒙版没有完全透明的待编辑区域，请将需要修改的位置设为透明");
        return mask.toImage();
    }

    /** 校验后保留原始字节，避免上传时损失细节或透明通道。 */
    private LoadedImage readSource(JsonNode value, Workspace workspace) throws IOException {
        ImageToolChecks.rejectIf(!value.isTextual() || value.asText().isBlank(), "输入图片路径必须为非空文件路径；不使用时请省略该参数");
        String path = value.asText().trim();
        Path target;
        try {
            target = workspace.resolve(path);
        } catch (InvalidPathException invalid) {
            throw new ClientException("参考图路径格式不正确，请提供工作区内的图片文件路径");
        }
        ImageToolChecks.rejectIf(!workspace.encloses(target), "参考图只能读取工作区内的图片");
        if (workspace.bridge() instanceof LocalWorkspaceBridge) {
            ImageToolChecks.rejectIf(!Files.isRegularFile(target), "参考图文件不存在或不是普通文件");
            // 几何包含关系挡不住目录链接，必须再核对真实文件归属。
            ImageToolChecks.rejectIf(!target.toRealPath().startsWith(Path.of(workspace.workDir()).toRealPath()),
                    "参考图的真实文件位于工作区之外");
            ImageToolChecks.rejectIf(Files.size(target) > MAX_BYTES, "参考图不能超过 16MB");
        }
        byte[] bytes = workspace.bridge().files().readBytes(target);
        ImageToolChecks.rejectIf(bytes.length > MAX_BYTES, "参考图不能超过 16MB");
        ImageFormat format = ImageFormat.detect(bytes);
        ImageToolChecks.rejectIf(format == null || !format.isPngOrJpeg(), "参考图必须为 PNG 或 JPEG，请先转换图片格式");
        try {
            ImageNormalizer.ImageSize size = normalizer.probe(bytes);
            ImageToolChecks.rejectIf(size.width() <= 0 || size.height() <= 0
                    || (long) size.width() * size.height() > ImageNormalizer.MAX_PIXELS, "参考图尺寸无效或超过 4000 万像素，请先缩小图片");
            ImageToolChecks.rejectIf(ImageIO.read(new ByteArrayInputStream(bytes)) == null, "参考图无法解码，请检查文件是否损坏");
        } catch (IOException invalid) {
            throw new ClientException("参考图无法解码，请检查文件是否损坏");
        }
        return new LoadedImage(bytes, format);
    }

    /** 已校验的原图字节；模型 SDK 要 base64 + mimeType，蒙版比对要原始字节。 */
    private record LoadedImage(byte[] bytes, ImageFormat format) {

        private Image toImage() {
            return Image.from(Base64.getEncoder().encodeToString(bytes), format.mimeType());
        }
    }
}

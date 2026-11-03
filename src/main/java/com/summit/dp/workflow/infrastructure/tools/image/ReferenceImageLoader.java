package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Image;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.Base64;

/** 润色依赖原图细节，不沿用看图流程的缩放与重编码。 */
@Component
public class ReferenceImageLoader {
    static final int MAX_BYTES = 16 * 1024 * 1024;
    private final ImageNormalizer normalizer = new ImageNormalizer();

    public Image load(JsonNode args, Workspace workspace) throws IOException {
        if (!args.has("reference_image_path")) return null;
        JsonNode value = args.path("reference_image_path");
        throwIf(!value.isTextual() || value.asText().isBlank(), "参考图 reference_image_path 必须为非空文件路径；不使用参考图时请省略该参数");
        String path = value.asText().trim();
        Path target;
        try {
            target = workspace.resolve(path);
        } catch (InvalidPathException invalid) {
            throw new ClientException("参考图路径格式不正确，请提供工作区内的图片文件路径");
        }
        throwIf(!workspace.encloses(target), "参考图只能读取工作区内的图片");
        if (workspace.bridge() instanceof LocalWorkspaceBridge) {
            throwIf(!Files.isRegularFile(target), "参考图文件不存在或不是普通文件");
            // 几何包含关系挡不住目录链接，必须再核对真实文件归属。
            throwIf(!target.toRealPath().startsWith(Path.of(workspace.workDir()).toRealPath()), "参考图的真实文件位于工作区之外");
            throwIf(Files.size(target) > MAX_BYTES, "参考图不能超过 16MB");
        }
        byte[] bytes = workspace.bridge().files().readBytes(target);
        throwIf(bytes.length > MAX_BYTES, "参考图不能超过 16MB");
        ImageFormat format = ImageFormat.detect(bytes);
        throwIf(format != ImageFormat.PNG && format != ImageFormat.JPEG, "参考图必须为 PNG 或 JPEG，请先转换图片格式");
        try {
            ImageNormalizer.ImageSize size = normalizer.probe(bytes);
            throwIf(size.width() <= 0 || size.height() <= 0
                    || (long) size.width() * size.height() > ImageNormalizer.MAX_PIXELS, "参考图尺寸无效或超过 4000 万像素，请先缩小图片");
            throwIf(ImageIO.read(new ByteArrayInputStream(bytes)) == null, "参考图无法解码，请检查文件是否损坏");
        } catch (IOException invalid) {
            throw new ClientException("参考图无法解码，请检查文件是否损坏");
        }
        return Image.from(Base64.getEncoder().encodeToString(bytes), format.mimeType());
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

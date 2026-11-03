package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.agent.Image;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.time.Duration;
import java.util.Base64;

/** 工作区写入继续走桥接；远端图片先固化，预览不依赖临时链接。 */
@Component
public class GeneratedImageFileWriter {
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build();
    private final ImageNormalizer normalizer = new ImageNormalizer();
    private final GeneratedImageOutputValidator outputValidator = new GeneratedImageOutputValidator();

    /** 本地桥接需复核真实父目录，避免工作区内的链接把写入导向外部。 */
    public void validateTarget(Workspace workspace, Path target) throws IOException {
        if (!(workspace.bridge() instanceof LocalWorkspaceBridge)) return;
        Path root = Path.of(workspace.workDir()).toRealPath();
        Path existing = target;
        while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) existing = existing.getParent();
        if (existing == null || !existing.toRealPath().startsWith(root)) throw new IOException("生图路径的真实目录位于工作区之外");
    }

    public byte[] load(Image image, String extension) throws Exception {
        return load(image, extension, null);
    }

    public byte[] load(Image image, String extension, ImageGenerationOptions options) throws Exception {
        byte[] bytes;
        if (image.getBase64Data() != null && !image.getBase64Data().isBlank()) {
            if (image.getBase64Data().length() > (long) MAX_BYTES * 4 / 3 + 4) throw new IOException("生图结果超过 16MB");
            bytes = Base64.getDecoder().decode(image.getBase64Data());
        } else {
            URI url = image.getUrl();
            if (url == null || !("https".equalsIgnoreCase(url.getScheme()) || "http".equalsIgnoreCase(url.getScheme()))) {
                throw new IOException("生图模型没有返回可用的图片数据或 HTTP 地址");
            }
            HttpRequest request = HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(60)).GET().build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream input = response.body()) {
                if (response.statusCode() != 200) throw new IOException("下载生图结果失败，HTTP " + response.statusCode());
                bytes = input.readNBytes(MAX_BYTES + 1);
            }
        }
        if (bytes.length > MAX_BYTES) throw new IOException("生图结果超过 16MB");
        ImageFormat format = ImageFormat.detect(bytes);
        if (format != ImageFormat.PNG && format != ImageFormat.JPEG) throw new IOException("生图结果必须为 PNG 或 JPEG");
        ImageNormalizer.ImageSize size = normalizer.probe(bytes);
        if ((long) size.width() * size.height() > ImageNormalizer.MAX_PIXELS) throw new IOException("生图结果像素过大");
        outputValidator.validate(bytes, format, options);
        if (format.storedExtension().equals(extension)) return bytes;
        BufferedImage source = ImageIO.read(new ByteArrayInputStream(bytes));
        BufferedImage target = source;
        if ("jpg".equals(extension)) {
            target = new BufferedImage(source.getWidth(), source.getHeight(), BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = target.createGraphics();
            try { graphics.setColor(Color.WHITE); graphics.fillRect(0, 0, target.getWidth(), target.getHeight()); graphics.drawImage(source, 0, 0, null); }
            finally { graphics.dispose(); }
        }
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        if (!ImageIO.write(target, extension, encoded)) throw new IOException("无法转换生图文件格式");
        return encoded.toByteArray();
    }

    public void write(WorkspaceFiles files, Path path, byte[] bytes) throws IOException {
        if (files.exists(path)) throw new IOException("目标文件已存在，请选择其它路径");
        if (path.getParent() != null) files.createDirectories(path.getParent());
        // 桥接目前只提供带字符集写入；此字符集能让全部 256 种字节无损往返。
        files.writeString(path, new String(bytes, StandardCharsets.ISO_8859_1), StandardCharsets.ISO_8859_1);
    }
}

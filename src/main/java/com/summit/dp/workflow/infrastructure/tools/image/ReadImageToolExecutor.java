package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.*;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadImageRequest;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/**
 * {@code read_image}：把工作区里的一张图规整、落盘，并把图像元数据交给注入拦截器。
 *
 * <p>工具本身不返回像素 —— 工具回执是纯文本。图像由 {@code ImageInjectionInterceptor}
 * 在下一轮模型调用前作为一条用户消息注入。</p>
 */
@Slf4j
@Component
@Tool(
    id = ToolCatalog.READ_IMAGE,
    name = ToolCatalog.READ_IMAGE,
    executor = ReadImageToolExecutor.class,
    description = """
        Load one image from the workspace into your context so you can actually see it.
        The pixels are not inside this result: you get image metadata now, and the image itself
        arrives as a separate user message on your next turn, still within this same task.
        Images consume model input tokens.
        Only PNG/JPEG/GIF/BMP are accepted; the path must stay inside the workspace.
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "path", value = @Value(
                type = ValueType.STRING,
                description = "Image path inside the workspace. Relative paths are resolved against the workspace root."))
        },
        required = {"path"}),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 400,
    timeout = 20L)
public class ReadImageToolExecutor implements ToolExecutor {

    /** 单图字节上限：再大就不是「看一眼」的场景了。 */
    static final long MAX_BYTES = 10L * 1024 * 1024;

    private final ObjectMapper objectMapper;
    private final ImageNormalizer normalizer;
    private final ImageCacheDirectory cache;

    public ReadImageToolExecutor(ObjectMapper objectMapper, ImageNormalizer normalizer,
                                 ImageCacheDirectory cache) {
        this.objectMapper = objectMapper;
        this.normalizer = normalizer;
        this.cache = cache;
    }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return read(toolExecution);
        } catch (ReadRejected rejected) {
            return failure(rejected.reason, rejected.detail);
        }
    }

    /** 解析 → 校验闸门 → 读取字节 → 探测与规整 → 组装回执，失败统一由 {@link ReadRejected} 带回出口。 */
    private ToolExecuteResult read(ToolExecution toolExecution) {
        String displayPath = requestedPath(toolExecution);
        Workspace workspace = requireWorkspace(toolExecution);
        Path target = resolveInsideWorkspace(workspace, displayPath);
        Map<String, Object> attributes = toolExecution.getAttributes() == null ? Map.of() : toolExecution.getAttributes();
        long sessionId = requireVisionSession(attributes);
        byte[] raw = readBytes(workspace, target, displayPath);
        ImageFormat format = requireSupportedFormat(raw);
        requireSafePixelCount(raw, displayPath);
        StoredImage stored = encodeAndCache(raw, format, sessionId, displayPath);
        return ToolExecuteResult.success(
                receipt(displayPath, stored.cached(), stored.normalized()),
                ToolResultType.NORMAL,
                metadata(stored.cached(), stored.normalized(), displayPath));
    }

    private String requestedPath(ToolExecution toolExecution) {
        ReadImageRequest request;
        try {
            request = objectMapper.readValue(toolExecution.getArgs(), ReadImageRequest.class);
        } catch (Exception malformed) {
            throw new ReadRejected("READ_FAILED", "参数无法解析，需要 {\"path\": \"...\"}");
        }
        if (request == null || request.getPath() == null || request.getPath().isBlank()) {
            throw new ReadRejected("READ_FAILED", "path 不能为空");
        }
        String displayPath = request.getPath().trim();
        log.info("读取工作区图片: path={}", displayPath);
        return displayPath;
    }

    private Workspace requireWorkspace(ToolExecution toolExecution) {
        Workspace workspace = toolExecution.getWorkspace();
        if (workspace == null) throw new ReadRejected("READ_FAILED", "当前执行没有可用的工作区");
        return workspace;
    }

    /** 只认工作区内路径：读图不需要越界能力，越界读还会绕开沙箱的文件策略。 */
    private Path resolveInsideWorkspace(Workspace workspace, String displayPath) {
        Path target;
        try {
            target = workspace.resolve(displayPath);
        } catch (InvalidPathException invalid) {
            throw new ReadRejected("READ_FAILED", "图片路径格式不正确");
        }
        if (!workspace.encloses(target)) {
            throw new ReadRejected("OUTSIDE_WORKSPACE", "只能读取工作区内的图片: " + displayPath);
        }
        return target;
    }

    /** 缺少视觉能力或会话标识时无需读取文件。 */
    private long requireVisionSession(Map<String, Object> attributes) {
        if (!Boolean.TRUE.equals(attributes.get(ExecutionAttributes.MODEL_VISION))) {
            throw new ReadRejected("VISION_UNAVAILABLE", "当前模型不支持直接读取图片，请改用文字描述或换用视觉模型");
        }
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        if (sessionId == null) {
            throw new ReadRejected("READ_FAILED", "会话标识缺失，无法定位图片缓存");
        }
        return sessionId;
    }

    private byte[] readBytes(Workspace workspace, Path target, String displayPath) {
        byte[] raw;
        try {
            if (!Files.isRegularFile(target)) {
                throw new ReadRejected("READ_FAILED", "不是可读的图片文件: " + displayPath);
            }
            // 几何包含关系挡不住目录链接，读取前还要核对真实文件的归属。
            if (!workspace.encloses(target.toRealPath())) {
                String workDir = workspace.workDir();
                // 工作区根目录本身也可能是链接，按它的真实根目录判断归属。
                if (workDir == null || workDir.isBlank()
                        || !target.toRealPath().startsWith(Path.of(workDir).toRealPath())) {
                    throw new ReadRejected("OUTSIDE_WORKSPACE", "只能读取工作区内的图片: " + displayPath);
                }
            }
            if (Files.size(target) > MAX_BYTES) {
                throw new ReadRejected("FILE_TOO_LARGE", "图片超过 " + (MAX_BYTES / 1024 / 1024) + "MB");
            }
            WorkspaceFiles files = workspace.bridge().files();
            raw = files.readBytes(target);
        } catch (IOException unreadable) {
            // 沙箱路径映射不等价时，宿主看不到这个文件；不要抛异常炸整轮。
            log.warn("读取图片失败: path={}", displayPath, unreadable);
            throw new ReadRejected("SANDBOX_UNREADABLE", "该工作区无法按字节读取此文件: " + displayPath);
        }
        if (raw.length > MAX_BYTES) {
            throw new ReadRejected("FILE_TOO_LARGE", "图片超过 " + (MAX_BYTES / 1024 / 1024) + "MB");
        }
        return raw;
    }

    private ImageFormat requireSupportedFormat(byte[] raw) {
        ImageFormat format = ImageFormat.detect(raw);
        if (format != null) return format;
        String label = ImageFormat.unsupportedLabel(raw);
        if (label != null) throw new ReadRejected("UNSUPPORTED_FORMAT", label + " 暂不支持，请先转换为 PNG/JPEG");
        throw new ReadRejected("NOT_AN_IMAGE", "文件头不是 PNG/JPEG/GIF/BMP");
    }

    /** 尺寸闸门必须早于解码：一张解压炸弹不该被 {@code normalize} 先展开。 */
    private void requireSafePixelCount(byte[] raw, String displayPath) {
        ImageNormalizer.ImageSize size;
        try {
            size = normalizer.probe(raw);
        } catch (IOException undecodable) {
            log.warn("图片尺寸探测失败: path={}", displayPath, undecodable);
            throw new ReadRejected("NOT_AN_IMAGE", "图片解码失败，文件可能已损坏");
        }
        if ((long) size.width() * size.height() > ImageNormalizer.MAX_PIXELS) {
            throw new ReadRejected("PIXEL_BOMB", "图片像素过大（" + size.width() + "×" + size.height() + "），请先压缩");
        }
    }

    /** 规整与落盘共用一个 catch：对用户而言两者都是「这图转换不出来」。 */
    private StoredImage encodeAndCache(byte[] raw, ImageFormat format, long sessionId, String displayPath) {
        try {
            ImageNormalizer.NormalizedImage normalized = normalizer.normalize(raw, format);
            ImageCacheDirectory.CachedImage cached = cache.store(sessionId, normalized.data(), normalized.extension());
            return new StoredImage(normalized, cached);
        } catch (IOException encodeFailed) {
            log.warn("图片规整失败: path={}", displayPath, encodeFailed);
            throw new ReadRejected("READ_FAILED", "图片转换失败，请换一张图或先转为 PNG/JPEG");
        }
    }

    private String receipt(String displayPath, ImageCacheDirectory.CachedImage cached,
                           ImageNormalizer.NormalizedImage normalized) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("ok", true);
        ArrayNode images = root.putArray("images");
        ObjectNode image = images.addObject();
        image.put("imageId", cached.imageId());
        image.put("ext", normalized.extension());
        image.put("path", displayPath);
        image.put("mimeType", normalized.mimeType());
        image.put("width", normalized.width());
        image.put("height", normalized.height());
        image.put("bytes", normalized.data().length);
        root.put("note", "图像将在下一轮按图片窗口保留，已移出窗口的图可重新读取");
        return root.toString();
    }

    private Map<String, Object> metadata(ImageCacheDirectory.CachedImage cached,
                                         ImageNormalizer.NormalizedImage normalized, String displayPath) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("imageId", cached.imageId());
        metadata.put("ext", normalized.extension());
        metadata.put("mimeType", normalized.mimeType());
        metadata.put("width", normalized.width());
        metadata.put("height", normalized.height());
        metadata.put("path", displayPath);
        return Map.copyOf(metadata);
    }

    private ToolExecuteResult failure(String reason, String detail) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("ok", false);
        root.put("reason", reason);
        root.put("detail", detail);
        return ToolExecuteResult.err(root.toString());
    }

    /** 规整结果与缓存句柄：回执与元数据都要同时用到两者。 */
    private record StoredImage(ImageNormalizer.NormalizedImage normalized, ImageCacheDirectory.CachedImage cached) {
    }

    /**
     * 链路深处的校验失败信号。
     *
     * <p>用它把 {@code reason}/{@code detail} 带回唯一出口，避免每个校验点都写一遍 {@code return failure(...)}；
     * 不填栈、不填 cause，因为它不是异常路径而是既定的失败分支。</p>
     */
    private static final class ReadRejected extends RuntimeException {

        private final String reason;
        private final String detail;

        private ReadRejected(String reason, String detail) {
            super(detail, null, false, false);
            this.reason = reason;
            this.detail = detail;
        }
    }

}

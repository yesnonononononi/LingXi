package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.anno.Tool;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolResultType;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadImageRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

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
        Images consume model input tokens; one execution may receive at most 15 distinct images.
        Only PNG/JPEG/GIF/BMP are accepted; the path must stay inside the workspace.
        """,
    parametersJsonSchema = """
        {
          "type": "object",
          "properties": {
            "path": {"type": "string", "description": "Image path inside the workspace. Relative paths are resolved against the workspace root."}
          },
          "required": ["path"]
        }
        """,
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 400,
    timeout = 20L)
public class ReadImageToolExecutor implements ToolExecutor {

    /** 单图字节上限：再大就不是「看一眼」的场景了。 */
    static final long MAX_BYTES = 10L * 1024 * 1024;
    /** 单次执行可注入的图片张数上限：base64 会随执行快照每轮重写，必须有闸门。 */
    static final int MAX_IMAGE_BUDGET = 15;
    /** 已注入计数键，与注入拦截器共用。 */
    public static final String KEY_CONSUMED = "lingxi.image.consumed";

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
        ReadImageRequest request;
        try {
            request = objectMapper.readValue(toolExecution.getArgs(), ReadImageRequest.class);
        } catch (Exception malformed) {
            return failure("READ_FAILED", "参数无法解析，需要 {\"path\": \"...\"}");
        }
        if (request == null || request.getPath() == null || request.getPath().isBlank()) {
            return failure("READ_FAILED", "path 不能为空");
        }
        String displayPath = request.getPath().trim();
        if (displayPath.isBlank()) return failure("READ_FAILED", "图片路径不能为空");
        log.info("读取工作区图片: path={}", displayPath);

        Workspace workspace = toolExecution.getWorkspace();
        if (workspace == null) return failure("READ_FAILED", "当前执行没有可用的工作区");
        Path target;
        try {
            target = workspace.resolve(displayPath);
        } catch (InvalidPathException invalid) {
            return failure("READ_FAILED", "图片路径格式不正确");
        }
        // 只认工作区内路径：读图不需要越界能力，越界读还会绕开沙箱的文件策略。
        if (!workspace.encloses(target)) {
            return failure("OUTSIDE_WORKSPACE", "只能读取工作区内的图片: " + displayPath);
        }

        Map<String, Object> attributes = toolExecution.getAttributes() == null ? Map.of() : toolExecution.getAttributes();
        if (!Boolean.TRUE.equals(attributes.get(ExecutionAttributes.MODEL_VISION))) {
            return failure("VISION_UNAVAILABLE", "当前模型不支持直接读取图片，请改用文字描述或换用视觉模型");
        }
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        if (sessionId == null) {
            return failure("READ_FAILED", "会话标识缺失，无法定位图片缓存");
        }
        if (consumed(attributes) >= MAX_IMAGE_BUDGET) {
            return failure("BUDGET_EXHAUSTED", "本次执行最多读取 " + MAX_IMAGE_BUDGET + " 张图片");
        }

        byte[] raw;
        try {
            if (!Files.isRegularFile(target)) {
                return failure("READ_FAILED", "不是可读的图片文件: " + displayPath);
            }
            // 几何包含关系挡不住目录链接，读取前还要核对真实文件的归属。
            if (!workspace.encloses(target.toRealPath())) {
                String workDir = workspace.workDir();
                // 工作区根目录本身也可能是链接，按它的真实根目录判断归属。
                if (workDir == null || workDir.isBlank()
                        || !target.toRealPath().startsWith(Path.of(workDir).toRealPath())) {
                    return failure("OUTSIDE_WORKSPACE", "只能读取工作区内的图片: " + displayPath);
                }
            }
            if (Files.size(target) > MAX_BYTES) {
                return failure("FILE_TOO_LARGE", "图片超过 " + (MAX_BYTES / 1024 / 1024) + "MB");
            }
            WorkspaceFiles files = workspace.bridge().files();
            raw = files.readBytes(target);
        } catch (IOException unreadable) {
            // 沙箱路径映射不等价时，宿主看不到这个文件；不要抛异常炸整轮。
            log.warn("读取图片失败: path={}", displayPath, unreadable);
            return failure("SANDBOX_UNREADABLE", "该工作区无法按字节读取此文件: " + displayPath);
        }
        if (raw.length > MAX_BYTES) {
            return failure("FILE_TOO_LARGE", "图片超过 " + (MAX_BYTES / 1024 / 1024) + "MB");
        }

        ImageFormat format = ImageFormat.detect(raw);
        if (format == null) {
            String label = ImageFormat.unsupportedLabel(raw);
            if (label != null) return failure("UNSUPPORTED_FORMAT", label + " 暂不支持，请先转换为 PNG/JPEG");
            return failure("NOT_AN_IMAGE", "文件头不是 PNG/JPEG/GIF/BMP");
        }

        ImageNormalizer.ImageSize size;
        try {
            size = normalizer.probe(raw);
        } catch (IOException undecodable) {
            log.warn("图片尺寸探测失败: path={}", displayPath, undecodable);
            return failure("NOT_AN_IMAGE", "图片解码失败，文件可能已损坏");
        }
        if ((long) size.width() * size.height() > ImageNormalizer.MAX_PIXELS) {
            return failure("PIXEL_BOMB", "图片像素过大（" + size.width() + "×" + size.height() + "），请先压缩");
        }

        ImageNormalizer.NormalizedImage normalized;
        ImageCacheDirectory.CachedImage cached;
        try {
            normalized = normalizer.normalize(raw, format);
            cached = cache.store(sessionId, normalized.data(), normalized.extension());
        } catch (IOException encodeFailed) {
            log.warn("图片规整失败: path={}", displayPath, encodeFailed);
            return failure("READ_FAILED", "图片转换失败，请换一张图或先转为 PNG/JPEG");
        }

        return ToolExecuteResult.success(
                receipt(displayPath, cached, normalized, consumed(attributes) + 1),
                ToolResultType.NORMAL,
                metadata(cached, normalized, displayPath));
    }

    private String receipt(String displayPath, ImageCacheDirectory.CachedImage cached,
                           ImageNormalizer.NormalizedImage normalized, int used) {
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
        ObjectNode budget = root.putObject("budget");
        budget.put("used", used);
        budget.put("max", MAX_IMAGE_BUDGET);
        root.put("note", "图像将在下一轮作为用户消息注入你的上下文");
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

    private int consumed(Map<String, Object> attributes) {
        Long value = ExecutionAttributes.readLong(attributes, KEY_CONSUMED);
        return value == null ? 0 : value.intValue();
    }

}

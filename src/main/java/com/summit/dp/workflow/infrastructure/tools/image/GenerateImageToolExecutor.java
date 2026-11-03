package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.IntegerValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.agent.Image;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.image.ImageModel;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolResultType;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 生图为独立工具调用，主模型继续负责提示词、工具编排和最终回复。 */
@Component
@RequiredArgsConstructor
@Tool(id = ToolCatalog.GENERATE_IMAGE, name = ToolCatalog.GENERATE_IMAGE, executor = GenerateImageToolExecutor.class,
        description = "使用已配置的生图模型生成一张图片，保存到工作区内的新文件，不覆盖已有文件。"
                + "可传 reference_image_path 润色工作区内的一张 PNG/JPEG；省略则按文字生成。参考图传路径，不传 Base64，也无需先调用 read_image。"
                + "编辑需要模型和服务端支持图片编辑接口，不支持时直接返回错误。"
                + "可传 mask_image_path 使用同尺寸透明 PNG 蒙版，完全透明区域为待编辑位置。"
                + "background 与 output_format 是向服务端显式请求，格式或透明度不符合要求会返回失败。"
                + "prompt 必须完整自洽，path 使用相对路径。size、quality、count 均可不传：默认尺寸沿用模型配置，"
                + "未配置尺寸时为 1024x1024；默认质量沿用模型配置，未配置则由服务端决定；每次固定一张。"
                + "本地只校验参数格式，模型不支持的尺寸或质量由工具返回服务端错误信息。调用有次数上限，失败也占次数。"
                + "回复时用 ![图片描述](previewUrl) 展示结果，需要查看像素时使用 read_image。",
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "prompt", value = @Value(type = ValueType.STRING, description = "完整、自洽的生图提示词。")),
                @ToolProperty(key = "path", value = @Value(type = ValueType.STRING, description = "相对于工作区的新图片路径，扩展名为 .png、.jpg 或 .jpeg，不覆盖已有文件。")),
                @ToolProperty(key = "reference_image_path", value = @Value(type = ValueType.STRING,
                        description = "可不传。用于润色的单张 PNG/JPEG 文件路径，支持工作区内的相对或绝对路径；不接受 URL 或 Base64。图片不超过 16MB、4000 万像素，保持原图字节。")),
                @ToolProperty(key = "mask_image_path", value = @Value(type = ValueType.STRING,
                        description = "可不传。工作区内 PNG 蒙版路径，必须同时传参考图；尺寸与参考图一致，包含 alpha 通道，完全透明区域为待编辑位置。")),
                @ToolProperty(key = "background", value = @Value(type = ValueType.STRING,
                        description = "可不传。transparent 请求透明背景，opaque 请求不透明背景，auto 由服务端决定。transparent 必须保存为 PNG，省略 output_format 时自动请求 png。")),
                @ToolProperty(key = "output_format", value = @Value(type = ValueType.STRING,
                        description = "可不传。显式请求 png 或 jpeg，必须与 path 扩展名一致。服务端返回的实际格式不符时失败，不通过转码伪装成功。")),
                @ToolProperty(key = "size", value = @Value(type = ValueType.STRING, description = ImageGenerationSpecValidator.SIZE_DESCRIPTION)),
                @ToolProperty(key = "quality", value = @Value(type = ValueType.STRING, description = ImageGenerationSpecValidator.QUALITY_DESCRIPTION)),
                @ToolProperty(key = "count", value = @Value(type = ValueType.INTEGER, integerValue = @IntegerValue(enums = 1, defaultValue = 1),
                        description = "可不传，默认 1。每次仅生成一张图片，保存到 path 指定的文件。"))
        }, required = {"prompt", "path"}, additionalProperties = OptionalBoolean.FALSE), concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION, timeout = 360L, maxOutput = 700)
public class GenerateImageToolExecutor implements ToolExecutor {
    private final ObjectMapper mapper;
    private final ModelService models;
    private final ModelProviderRegistry<ImageModel> providers;
    private final GeneratedImageFileWriter writer;
    private final ImageCacheDirectory cache;
    private final ImageGenerationSpecValidator specifications;
    private final ReferenceImageLoader references;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution execution) {
        Map<String, Object> metadata = new HashMap<>();
        try {
            JsonNode args = arguments(execution);
            GeneratedImageTarget target = writableTarget(execution, args);
            GenerationQuota quota = authorizedQuota(execution);
            ImageGenerationOptions options = specifications.resolve(args, quota.config());
            Image reference = references.load(args, target.workspace());
            Image mask = references.loadMask(args, target.workspace(), reference);
            ChatResponseEntity response = requestImage(quota.config(), args.path("prompt").asText(), options, reference, mask);
            // 用量先落进 metadata：后面任何一步失败，错误回执仍要带上已计费的 token。
            if (response.getTokenUsage() != null) metadata.put(GenerateImageInterceptor.USAGE, mapper.convertValue(response.getTokenUsage(), Map.class));
            ImageToolChecks.rejectIf(response.getAiMessageEntity() == null || response.getAiMessageEntity().getImages() == null
                    || response.getAiMessageEntity().getImages().size() != 1, "生图模型未返回一张完整图片");
            byte[] bytes = writer.load(response.getAiMessageEntity().getImages().getFirst(), target.extension(), options);
            writer.write(target.files(), target.path(), bytes);
            ImageCacheDirectory.CachedImage preview = cache.store(quota.sessionId(), bytes, target.extension());
            String url = "/a/images/" + quota.sessionId() + "/" + preview.imageId() + "." + target.extension();
            metadata.put("generatedImage", Map.of("path", target.relativePath(), "previewUrl", url, "bytes", bytes.length));
            return ToolExecuteResult.success(mapper.writeValueAsString(Map.of("ok", true, "path", target.relativePath(),
                    "previewUrl", url, "bytes", bytes.length, "modelName", quota.config().getModelName(), "size", options.size(),
                    "note", "在回复中使用 ![图片描述](previewUrl) 展示生成结果；工作区文件已保存。")), ToolResultType.NORMAL, Map.copyOf(metadata));
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            return ToolExecuteResult.err("生图失败: " + error.getMessage(), ToolResultType.NORMAL, Map.copyOf(metadata));
        }
    }

    private JsonNode arguments(ToolExecution execution) throws Exception {
        JsonNode args = mapper.readTree(execution.getArgs());
        ImageToolChecks.rejectIf(args == null || !args.path("prompt").isTextual() || args.path("prompt").asText().isBlank(),
                "生图提示词 prompt 不能为空");
        ImageToolChecks.rejectIf(!args.path("path").isTextual() || args.path("path").asText().isBlank(),
                "生图文件路径 path 不能为空");
        return args;
    }

    /** 目标必须是工作区内的新文件：几何包含挡不住链接，真实目录还要再复核一次。 */
    private GeneratedImageTarget writableTarget(ToolExecution execution, JsonNode args) throws IOException {
        Workspace workspace = execution.getWorkspace();
        ImageToolChecks.rejectIf(workspace == null, "生图需要先配置工作区");
        String relativePath = args.path("path").asText().trim();
        ImageToolChecks.rejectIf(Path.of(relativePath).isAbsolute(), "生图文件路径必须相对于工作区");
        Path target = workspace.resolve(relativePath);
        ImageToolChecks.rejectIf(!workspace.encloses(target), "生图文件只能保存在工作区内");
        String lower = relativePath.toLowerCase(Locale.ROOT);
        ImageToolChecks.rejectIf(!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")),
                "生图文件扩展名必须是 png、jpg 或 jpeg");
        String extension = lower.endsWith(".png") ? ImageFormat.PNG.storedExtension() : ImageFormat.JPEG.storedExtension();
        WorkspaceFiles files = workspace.bridge().files();
        ImageToolChecks.rejectIf(files.exists(target), "生图目标文件已存在，请选择其它路径");
        writer.validateTarget(workspace, target);
        return new GeneratedImageTarget(workspace, target, files, extension, relativePath);
    }

    /** 配额与模型配置：只有被放行的那次调用才有模型，且上限口径与拦截器一致。 */
    private GenerationQuota authorizedQuota(ToolExecution execution) {
        Map<String, Object> attributes = execution.getAttributes();
        Long modelId = ExecutionAttributes.readLong(attributes, GenerateImageInterceptor.MODEL);
        ImageToolChecks.rejectIf(modelId == null, "请先在其它模型配置中选择生图模型");
        Object allowed = attributes.get(GenerateImageInterceptor.ALLOWED);
        ImageToolChecks.rejectIf(!(allowed instanceof List<?> ids) || !ids.contains(execution.getId()),
                "本次执行已达到生图次数上限（" + GenerateImageInterceptor.number(attributes, GenerateImageInterceptor.LIMIT) + " 次）");
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        ImageToolChecks.rejectIf(sessionId == null, "生图执行缺少会话标识");
        ModelConfig config = models.runtimeConfig(modelId, null);
        ImageToolChecks.rejectIf(!DefaultModelProviderNames.DEFAULT_IMAGE.equals(config.getProvider()), "配置的生图模型不是图片模型，请重新选择");
        return new GenerationQuota(sessionId, config);
    }

    /** 按参考图/蒙版分派 generate 或 edit；一次工具调用只发一次请求，避免 SDK 重试绕过执行次数上限。 */
    private ChatResponseEntity requestImage(ModelConfig config, String prompt, ImageGenerationOptions options,
                                            Image reference, Image mask) throws Exception {
        ImageModel model = providers.create(config.toBuilder().maxRetries(0).build());
        if (reference == null) return model.generate(prompt, options);
        if (mask == null) return model.edit(reference, prompt, options);
        return model.edit(reference, mask, prompt, options);
    }

    /** 校验过的落盘目标：桥接文件句柄、扩展名与回执里的相对路径。 */
    private record GeneratedImageTarget(Workspace workspace, Path path, WorkspaceFiles files,
                                        String extension, String relativePath) {
    }

    /** 已放行的配额：会话标识、上限配置与本次可用的生图模型。 */
    private record GenerationQuota(long sessionId, ModelConfig config) {
    }
}

package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.image.ImageModel;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolResultType;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 生图为独立工具调用，主模型继续负责提示词、工具编排和最终回复。 */
@Component
@RequiredArgsConstructor
@Tool(id = ToolCatalog.GENERATE_IMAGE, name = ToolCatalog.GENERATE_IMAGE, executor = GenerateImageToolExecutor.class,
        description = "Generate one image with the configured image model and save it to a NEW workspace file. "
                + "Provide a complete self-contained prompt and a relative .png/.jpg path. Never overwrite existing files. "
                + "Calls are limited per execution; failed calls also consume quota. Return the previewUrl in Markdown "
                + "![description](previewUrl) to display the result. Use read_image if you need to inspect the pixels.",
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "prompt", value = @Value(type = ValueType.STRING, description = "Complete image generation prompt.")),
                @ToolProperty(key = "path", value = @Value(type = ValueType.STRING, description = "New image file path relative to the workspace root, ending in .png or .jpg."))
        }, required = {"prompt", "path"}), concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION, timeout = 360L, maxOutput = 700)
public class GenerateImageToolExecutor implements ToolExecutor {
    private final ObjectMapper mapper;
    private final ModelService models;
    private final ModelProviderRegistry<ImageModel> providers;
    private final GeneratedImageFileWriter writer;
    private final ImageCacheDirectory cache;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution execution) {
        Map<String, Object> metadata = new HashMap<>();
        try {
            JsonNode args = mapper.readTree(execution.getArgs());
            throwIf(args == null || !args.path("prompt").isTextual() || args.path("prompt").asText().isBlank(), "生图提示词 prompt 不能为空");
            throwIf(!args.path("path").isTextual() || args.path("path").asText().isBlank(), "生图文件路径 path 不能为空");
            Workspace workspace = execution.getWorkspace();
            throwIf(workspace == null, "生图需要先配置工作区");
            String path = args.path("path").asText().trim();
            throwIf(Path.of(path).isAbsolute(), "生图文件路径必须相对于工作区");
            Path target = workspace.resolve(path);
            throwIf(!workspace.encloses(target), "生图文件只能保存在工作区内");
            String lower = path.toLowerCase(Locale.ROOT);
            throwIf(!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")), "生图文件扩展名必须是 png、jpg 或 jpeg");
            String extension = lower.endsWith(".png") ? "png" : "jpg";
            WorkspaceFiles files = workspace.bridge().files();
            throwIf(files.exists(target), "生图目标文件已存在，请选择其它路径");
            writer.validateTarget(workspace, target);
            Map<String, Object> attributes = execution.getAttributes();
            Long modelId = ExecutionAttributes.readLong(attributes, GenerateImageInterceptor.MODEL);
            throwIf(modelId == null, "请先在其它模型配置中选择生图模型");
            Object allowed = attributes.get(GenerateImageInterceptor.ALLOWED);
            throwIf(!(allowed instanceof List<?> ids) || !ids.contains(execution.getId()),
                    "本次执行已达到生图次数上限（" + GenerateImageInterceptor.number(attributes, GenerateImageInterceptor.LIMIT) + " 次）");
            Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
            throwIf(sessionId == null, "生图执行缺少会话标识");
            ModelConfig config = models.runtimeConfig(modelId, null);
            throwIf(!DefaultModelProviderNames.DEFAULT_IMAGE.equals(config.getProvider()), "配置的生图模型不是图片模型，请重新选择");
            // 一次工具调用只发一次模型请求，避免 SDK 重试绕过执行次数上限。
            config = config.toBuilder().maxRetries(0).build();
            ChatResponseEntity response = providers.create(config).generate(args.path("prompt").asText());
            if (response.getTokenUsage() != null) metadata.put(GenerateImageInterceptor.USAGE, mapper.convertValue(response.getTokenUsage(), Map.class));
            throwIf(response.getAiMessageEntity() == null || response.getAiMessageEntity().getImages() == null
                    || response.getAiMessageEntity().getImages().size() != 1, "生图模型未返回一张完整图片");
            byte[] bytes = writer.load(response.getAiMessageEntity().getImages().getFirst(), extension);
            writer.write(files, target, bytes);
            ImageCacheDirectory.CachedImage preview = cache.store(sessionId, bytes, extension);
            String url = "/a/images/" + sessionId + "/" + preview.imageId() + "." + extension;
            metadata.put("generatedImage", Map.of("path", path, "previewUrl", url, "bytes", bytes.length));
            return ToolExecuteResult.success(mapper.writeValueAsString(Map.of("ok", true, "path", path,
                    "previewUrl", url, "bytes", bytes.length, "modelName", config.getModelName(),
                    "note", "在回复中使用 ![图片描述](previewUrl) 展示生成结果；工作区文件已保存。")), ToolResultType.NORMAL, Map.copyOf(metadata));
        } catch (Exception error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            return ToolExecuteResult.err("生图失败: " + error.getMessage(), ToolResultType.NORMAL, Map.copyOf(metadata));
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

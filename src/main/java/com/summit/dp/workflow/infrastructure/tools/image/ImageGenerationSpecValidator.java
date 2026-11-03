package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.util.regex.Pattern;
import java.util.Set;
import java.util.Locale;

/** 本地只检查参数格式，规格是否受模型支持交给服务端判断。 */
@Component
public class ImageGenerationSpecValidator {
    public static final String DEFAULT_SIZE = "1024x1024";
    public static final String SIZE_DESCRIPTION = "可不传。默认采用模型配置的尺寸，未配置时为 1024x1024。"
            + "使用正整数宽x高格式，例如 1536x1024，或 auto。模型不支持时由工具返回服务端错误信息。";
    public static final String QUALITY_DESCRIPTION = "可不传。默认沿用模型配置的质量，未配置则由服务端决定。"
            + "传入非空质量字符串；模型不支持时由工具返回服务端错误信息。";
    private static final Pattern DIMENSIONS = Pattern.compile("(?:auto|[1-9][0-9]*x[1-9][0-9]*)");

    public ImageGenerationOptions resolve(JsonNode args, ModelConfig config) {
        throwIf(args.hasNonNull("size") && !args.path("size").isTextual(), "生图尺寸 size 必须是字符串，例如 1024x1024；也可不传以使用默认规格");
        throwIf(args.hasNonNull("quality") && !args.path("quality").isTextual(), "生图质量 quality 必须是字符串，也可不传以使用默认规格");
        throwIf(args.hasNonNull("background") && !args.path("background").isTextual(), "背景 background 必须是 transparent、opaque 或 auto");
        throwIf(args.hasNonNull("output_format") && !args.path("output_format").isTextual(), "输出格式 output_format 必须是 png 或 jpeg");
        throwIf(args.hasNonNull("count") && (!args.path("count").isIntegralNumber() || !args.path("count").canConvertToInt()
                || args.path("count").intValue() != 1), "生图工具每次只生成一张图片，count 仅支持 1，可不传");
        ModelConfig.ImageOptions defaults = config.getImageOptions();
        String size = args.hasNonNull("size") ? args.path("size").asText()
                : defaults != null && defaults.size() != null && !defaults.size().isBlank() ? defaults.size() : DEFAULT_SIZE;
        String quality = args.hasNonNull("quality") ? args.path("quality").asText()
                : defaults != null && defaults.quality() != null && !defaults.quality().isBlank() ? defaults.quality() : null;
        throwIf(!DIMENSIONS.matcher(size).matches(), "生图尺寸 size 必须为正整数宽x高，例如 1536x1024，或 auto；可不传以使用默认规格");
        throwIf(quality != null && quality.isBlank(), "生图质量 quality 不能为空白字符串；可不传以使用默认规格");
        String background = args.hasNonNull("background") ? args.path("background").asText() : null;
        String outputFormat = args.hasNonNull("output_format") ? args.path("output_format").asText() : null;
        throwIf(background != null && !Set.of("transparent", "opaque", "auto").contains(background), "背景 background 仅支持 transparent、opaque 或 auto");
        throwIf(outputFormat != null && !Set.of("png", "jpeg").contains(outputFormat), "输出格式 output_format 仅支持 png 或 jpeg");
        if ("transparent".equals(background) && outputFormat == null) outputFormat = "png";
        throwIf("transparent".equals(background) && !"png".equals(outputFormat), "透明背景必须使用 PNG 输出");
        String path = args.path("path").asText().toLowerCase(Locale.ROOT);
        throwIf(outputFormat != null && !("png".equals(outputFormat) ? path.endsWith(".png") : path.endsWith(".jpg") || path.endsWith(".jpeg")),
                "输出格式 output_format 必须与保存路径 path 的扩展名一致");
        return new ImageGenerationOptions(size, quality, 1, background, outputFormat);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.image.ImageGenerationOptions;
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
    /** 生图接口的请求词汇，与落盘扩展名无关。 */
    private static final String BACKGROUND_TRANSPARENT = "transparent";
    private static final String FORMAT_PNG = "png";
    private static final String FORMAT_JPEG = "jpeg";
    private static final Set<String> BACKGROUNDS = Set.of(BACKGROUND_TRANSPARENT, "opaque", "auto");
    private static final Set<String> OUTPUT_FORMATS = Set.of(FORMAT_PNG, FORMAT_JPEG);

    public ImageGenerationOptions resolve(JsonNode args, ModelConfig config) {
        String requestedSize = readOptionalText(args, "size", "生图尺寸 size 必须是字符串，例如 1024x1024；也可不传以使用默认规格");
        String requestedQuality = readOptionalText(args, "quality", "生图质量 quality 必须是字符串，也可不传以使用默认规格");
        String background = readOptionalText(args, "background", "背景 background 必须是 transparent、opaque 或 auto");
        String outputFormat = readOptionalText(args, "output_format", "输出格式 output_format 必须是 png 或 jpeg");
        ImageToolChecks.rejectIf(args.hasNonNull("count") && (!args.path("count").isIntegralNumber() || !args.path("count").canConvertToInt()
                || args.path("count").intValue() != 1), "生图工具每次只生成一张图片，count 仅支持 1，可不传");
        ModelConfig.ImageOptions defaults = config.getImageOptions();
        String size = requestedSize != null ? requestedSize
                : defaults != null && defaults.size() != null && !defaults.size().isBlank() ? defaults.size() : DEFAULT_SIZE;
        String quality = requestedQuality != null ? requestedQuality
                : defaults != null && defaults.quality() != null && !defaults.quality().isBlank() ? defaults.quality() : null;
        ImageToolChecks.rejectIf(!DIMENSIONS.matcher(size).matches(), "生图尺寸 size 必须为正整数宽x高，例如 1536x1024，或 auto；可不传以使用默认规格");
        ImageToolChecks.rejectIf(quality != null && quality.isBlank(), "生图质量 quality 不能为空白字符串；可不传以使用默认规格");
        ImageToolChecks.rejectIf(background != null && !BACKGROUNDS.contains(background), "背景 background 仅支持 transparent、opaque 或 auto");
        ImageToolChecks.rejectIf(outputFormat != null && !OUTPUT_FORMATS.contains(outputFormat), "输出格式 output_format 仅支持 png 或 jpeg");
        String requestedFormat = BACKGROUND_TRANSPARENT.equals(background) && outputFormat == null ? FORMAT_PNG : outputFormat;
        ImageToolChecks.rejectIf(BACKGROUND_TRANSPARENT.equals(background) && !FORMAT_PNG.equals(requestedFormat), "透明背景必须使用 PNG 输出");
        String path = args.path("path").asText().toLowerCase(Locale.ROOT);
        ImageToolChecks.rejectIf(requestedFormat != null
                        && !(FORMAT_PNG.equals(requestedFormat) ? path.endsWith(".png") : path.endsWith(".jpg") || path.endsWith(".jpeg")),
                "输出格式 output_format 必须与保存路径 path 的扩展名一致");
        return new ImageGenerationOptions(size, quality, 1, background, requestedFormat);
    }

    /** 读取可选字符串参数：缺失返回 {@code null}，类型不对按 {@code wrongTypeHint} 报错。 */
    private static String readOptionalText(JsonNode args, String key, String wrongTypeHint) {
        if (!args.hasNonNull(key)) return null;
        ImageToolChecks.rejectIf(!args.path(key).isTextual(), wrongTypeHint);
        return args.path(key).asText();
    }
}

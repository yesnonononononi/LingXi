package com.summit.dp.workflow.infrastructure.tools.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.image.ImageGenerationOptions;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 不向服务端发送已知无效的规格，默认值也经过同一校验。 */
@Component
public class ImageGenerationSpecValidator {
    public static final String DEFAULT_SIZE = "1024x1024";
    public static final String SIZE_DESCRIPTION = "可不传。默认采用模型配置的尺寸，未配置时为 1024x1024。"
            + "使用宽x高格式；GPT Image 1 支持 1024x1024、1536x1024、1024x1536、auto；"
            + "GPT Image 2/2.5 还支持自定义尺寸：两边为 16 的倍数，最长边不超过 3840，"
            + "长短边比例不超过 3:1，总像素 655360～8294400。DALL·E 使用各自支持的预设尺寸。";
    public static final String QUALITY_DESCRIPTION = "可不传。默认沿用模型配置的质量，未配置则由服务端决定。"
            + "GPT Image 支持 auto、low、medium、high；2.5 还支持 xhigh、max；DALL·E 使用 standard 或 hd。";
    private static final Set<String> GPT_SIZES = Set.of("auto", DEFAULT_SIZE, "1536x1024", "1024x1536");
    private static final Set<String> DALLE_2_SIZES = Set.of("256x256", "512x512", DEFAULT_SIZE);
    private static final Set<String> DALLE_3_SIZES = Set.of(DEFAULT_SIZE, "1792x1024", "1024x1792");
    private static final Set<String> COMPATIBLE_SIZES = Set.of("auto", "256x256", "512x512", DEFAULT_SIZE,
            "1536x1024", "1024x1536", "1792x1024", "1024x1792");
    private static final Set<String> GPT_QUALITIES = Set.of("auto", "low", "medium", "high");
    private static final Set<String> GPT_25_QUALITIES = Set.of("auto", "low", "medium", "high", "xhigh", "max");
    private static final Set<String> COMPATIBLE_QUALITIES = Set.of("auto", "low", "medium", "high", "xhigh", "max", "standard", "hd");
    private static final Pattern DIMENSIONS = Pattern.compile("([1-9][0-9]{0,3})x([1-9][0-9]{0,3})");

    public ImageGenerationOptions resolve(JsonNode args, ModelConfig config) {
        throwIf(args.hasNonNull("size") && !args.path("size").isTextual(), "生图尺寸 size 必须是字符串，例如 1024x1024；也可不传以使用默认规格");
        throwIf(args.hasNonNull("quality") && !args.path("quality").isTextual(), "生图质量 quality 必须是字符串，也可不传以使用默认规格");
        throwIf(args.hasNonNull("count") && (!args.path("count").isIntegralNumber() || !args.path("count").canConvertToInt()
                || args.path("count").intValue() != 1), "生图工具每次只生成一张图片，count 仅支持 1，可不传");
        ModelConfig.ImageOptions defaults = config.getImageOptions();
        String size = args.hasNonNull("size") ? args.path("size").asText()
                : defaults != null && defaults.size() != null && !defaults.size().isBlank() ? defaults.size() : DEFAULT_SIZE;
        String quality = args.hasNonNull("quality") ? args.path("quality").asText()
                : defaults != null && defaults.quality() != null && !defaults.quality().isBlank() ? defaults.quality() : null;
        String model = config.getModelName() == null ? "" : config.getModelName().trim().toLowerCase(Locale.ROOT);
        model = model.substring(model.lastIndexOf('/') + 1);
        boolean dalle2 = model.equals("dall-e-2");
        boolean dalle3 = model.equals("dall-e-3");
        boolean gpt2 = model.equals("gpt-image-2") || model.startsWith("gpt-image-2-");
        boolean gpt25 = model.equals("gpt-image-2.5-sunburst") || model.startsWith("gpt-image-2.5-sunburst-")
                || model.equals("gpt-image-2.5-flare") || model.startsWith("gpt-image-2.5-flare-");
        boolean gpt1 = model.equals("gpt-image-1") || model.startsWith("gpt-image-1-") || model.startsWith("gpt-image-1.5");
        if (gpt2 || gpt25) {
            if (!"auto".equals(size)) {
                Matcher dimensions = DIMENSIONS.matcher(size);
                throwIf(!dimensions.matches(), "生图尺寸 size 必须为宽x高，例如 1536x864；也可传 auto 或不传");
                int width = Integer.parseInt(dimensions.group(1));
                int height = Integer.parseInt(dimensions.group(2));
                long pixels = (long) width * height;
                throwIf(width % 16 != 0 || height % 16 != 0 || Math.max(width, height) > 3840
                                || Math.max(width, height) > 3 * Math.min(width, height) || pixels < 655360 || pixels > 8294400,
                        "生图尺寸 " + size + " 不符合 " + config.getModelName() + " 规格：两边须为 16 的倍数，最长边不超过 3840，"
                                + "长短边比例不超过 3:1，总像素须在 655360～8294400；可不传 size 使用默认规格");
            }
        } else {
            // 兼容模型没有能力声明时只开放通用预设，不猜测自定义尺寸支持。
            Set<String> sizes = dalle2 ? DALLE_2_SIZES : dalle3 ? DALLE_3_SIZES : gpt1 ? GPT_SIZES : COMPATIBLE_SIZES;
            throwIf(!sizes.contains(size), "生图尺寸 " + size + " 不符合 " + config.getModelName() + " 规格，可选："
                    + String.join("、", sizes.stream().sorted().toList()) + "；可不传 size 使用默认规格");
        }
        Set<String> qualities = dalle2 ? Set.of("standard") : dalle3 ? Set.of("standard", "hd")
                : gpt25 ? GPT_25_QUALITIES : gpt1 || gpt2 ? GPT_QUALITIES : COMPATIBLE_QUALITIES;
        throwIf(quality != null && !qualities.contains(quality), "生图质量 " + quality + " 不符合 " + config.getModelName()
                + " 规格，可选：" + String.join("、", qualities.stream().sorted().toList()) + "；可不传 quality 使用默认规格");
        return new ImageGenerationOptions(size, quality, 1);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

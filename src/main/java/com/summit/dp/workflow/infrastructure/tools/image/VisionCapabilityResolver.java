package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.dp.tools.application.port.ToolCatalog;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** 业务尚未提供模型能力开关，暂用可覆盖的部署名单；未命中时拒绝读图。 */
@Component
public class VisionCapabilityResolver {

    private static final String DEFAULT_PATTERNS =
            "claude-*,gpt-4o*,gpt-4.1*,gpt-5*,gemini-*,qwen-vl*,glm-4v*";

    private final List<Pattern> patterns;

    public VisionCapabilityResolver(@Value("${lingxi.image.vision-patterns:" + DEFAULT_PATTERNS + "}") String configured) {
        this.patterns = compile(configured);
    }

    /** 模型名命中名单才返回 {@code true}；空名一律不支持。 */
    public boolean supports(String modelName) {
        if (modelName == null || modelName.isBlank()) return false;
        String normalized = modelName.toLowerCase(Locale.ROOT).trim();
        return patterns.stream().anyMatch(pattern -> pattern.matcher(normalized).matches());
    }

    /** 能力未确认时不暴露读图，避免模型收到图片后拒绝整个请求。 */
    public List<String> filterTools(List<String> tools, String modelName) {
        if (supports(modelName)) return tools;
        List<String> filtered = new ArrayList<>(tools);
        filtered.removeIf(name -> name != null && ToolCatalog.READ_IMAGE.equals(name.trim()));
        return filtered;
    }

    private List<Pattern> compile(String configured) {
        List<Pattern> compiled = new ArrayList<>();
        if (configured == null) return compiled;
        for (String item : configured.split(",")) {
            String wildcard = item.trim().toLowerCase(Locale.ROOT);
            if (wildcard.isEmpty()) continue;
            String regex = Pattern.quote(wildcard).replace("*", "\\E.*\\Q");
            compiled.add(Pattern.compile(regex));
        }
        return compiled;
    }
}

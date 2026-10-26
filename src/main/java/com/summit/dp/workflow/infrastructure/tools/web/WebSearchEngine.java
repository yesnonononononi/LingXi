package com.summit.dp.workflow.infrastructure.tools.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workflow.infrastructure.tools.arguments.WebSearchArguments;

import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * web_search 的执行引擎：收敛 maxResults、发起 HTTP 检索，并按工具输出上限决定是否调小模型摘要。
 *
 * <p>两个关键行为：</p>
 * <ol>
 *   <li><b>摘要触发阈值</b>：原始检索结果长度 <b>大于</b> {@code maxOutput * 110%} 才调用
 *       {@link WebResultSummarizer}；小于等于阈值直接返回原始输出，不浪费一次模型调用。</li>
 *   <li><b>显式降级</b>：摘要器返回 {@code null}（失败）时，返回
 *       {@link #SUMMARY_UNAVAILABLE_MARKER} 标记 + 裁剪后的原始内容，且总长度不超过 {@code maxOutput}。</li>
 * </ol>
 */
@Slf4j
@AllArgsConstructor
public class WebSearchEngine {

    /** 摘要不可用时的降级标记，长度计入裁剪预算。 */
    public static final String SUMMARY_UNAVAILABLE_MARKER = "[摘要不可用，以下为原始检索结果（已按输出上限截断）]";

    /** 摘要触发阈值占工具最大输出长度的百分比：原文字符数超过该比例才摘要。 */
    public static final int SUMMARY_TRIGGER_PERCENT = 110;

    /** 降级标记与原文之间的分隔符。 */
    public static final String FALLBACK_BODY_SEPARATOR = "\n";

    private final WebSearchConfig webSearchConfig;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final WebResultSummarizer webResultSummarizer;

    /**
     * 执行一次网页检索，返回最终可交给模型的文本。
     *
     * @param arguments 检索参数；{@code maxResults} 缺失或非法时收敛为配置上限
     * @return 摘要文本、原始输出，或带标记的降级结果，长度不超过 {@code maxOutput}
     * @throws IOException          HTTP 请求失败
     * @throws InterruptedException 请求被中断
     */
    public String search(WebSearchArguments arguments) throws IOException, InterruptedException {
        applyMaxResultsLimit(arguments);
        String rawResult = this.search(this.objectMapper.writeValueAsString(arguments));
        return summarizeOrFallback(rawResult);
    }

    /**
     * 按工具最大输出长度决定是否摘要，并在摘要不可用时安全降级。
     *
     * @param rawResult 原始检索结果，允许为 {@code null}
     * @return 原始结果、摘要结果或降级结果；除"maxOutput 未配置"外，长度都不超过 {@code maxOutput}
     */
    private String summarizeOrFallback(String rawResult) {
        String original = rawResult == null ? "" : rawResult;
        int maxOutput = resolveMaxOutput();
        if (maxOutput <= 0) {
            log.warn("web_search maxOutput 未配置，跳过摘要并原样返回检索结果: length={}", original.length());
            return original;
        }
        int threshold = thresholdOf(maxOutput);
        if (original.length() <= threshold) {
            log.debug("web_search 结果长度 {} 未超过摘要阈值 {}，直接返回原始输出", original.length(), threshold);
            return original;
        }
        String summary = summarizeQuietly(original);
        if (summary == null || summary.isBlank()) {
            return buildFallback(original, maxOutput);
        }
        return summary;
    }

    /**
     * 调用摘要器，并把任何异常收敛为 {@code null}（双保险：摘要器本身已不抛异常）。
     *
     * @param original 原始检索结果
     * @return 摘要文本；失败返回 {@code null}
     */
    private String summarizeQuietly(String original) {
        try {
            return webResultSummarizer == null ? null : webResultSummarizer.summary(original);
        } catch (Exception e) {
            log.warn("web_search 摘要器抛出异常，走降级分支: reason={}", e.toString());
            return null;
        }
    }

    /**
     * 构造降级结果：标记 + 裁剪后的原始内容，保证总长度不超过 {@code maxOutput}。
     *
     * @param original  原始检索结果
     * @param maxOutput 工具最大输出字符数（正数）
     * @return 长度 &lt;= {@code maxOutput} 的降级文本
     */
    private String buildFallback(String original, int maxOutput) {
        String prefix = SUMMARY_UNAVAILABLE_MARKER + FALLBACK_BODY_SEPARATOR;
        if (prefix.length() >= maxOutput) {
            // 极端情况：输出上限比标记还短，只能保留标记本身的前缀。
            return truncate(prefix, maxOutput);
        }
        int bodyBudget = maxOutput - prefix.length();
        return prefix + truncate(original, bodyBudget);
    }

    /**
     * 按字符长度裁剪，且不会把一个 UTF-16 代理对切成半个字符。
     *
     * @param text      待裁剪文本，允许为 {@code null}
     * @param maxLength 允许保留的最大字符数
     * @return 裁剪后的文本；{@code text} 为空或 {@code maxLength <= 0} 时返回空串
     */
    private static String truncate(String text, int maxLength) {
        if (text == null || maxLength <= 0) {
            return "";
        }
        if (text.length() <= maxLength) {
            return text;
        }
        int end = maxLength;
        if (Character.isHighSurrogate(text.charAt(end - 1))) {
            end = end - 1;
        }
        return text.substring(0, end);
    }

    /**
     * 摘要触发阈值：{@code maxOutput} 的 {@value #SUMMARY_TRIGGER_PERCENT}%（3000 × 110% = 3300），向下取整。
     *
     * <p>阈值定在 110% 是有意为之：结果只是略微超出输出上限（不超过 110%）时不值得多花一次模型调用，
     * 直接原样返回、由框架侧按 maxOutput 处理；只有明显超限才摘要。</p>
     *
     * @param maxOutput 工具最大输出字符数
     * @return 触发摘要的最小长度（严格大于该值才摘要）
     */
    public static int thresholdOf(int maxOutput) {
        if (maxOutput <= 0) {
            return 0;
        }
        return (int) ((long) maxOutput * SUMMARY_TRIGGER_PERCENT / 100L);
    }

    /** 读取配置中的 {@code maxOutput}；缺失时返回 {@code 0} 表示未配置。 */
    private int resolveMaxOutput() {
        if (webSearchConfig == null) {
            return 0;
        }
        Integer configured = webSearchConfig.maxOutput();
        return configured == null ? 0 : configured;
    }

    /**
     * 把可选的 {@code maxResults} 收敛为配置上限，避免"模型未传"直接进入数字解析。
     *
     * <p><b>缺陷</b>：{@code maxResults} 在参数 JSON schema 里是可选字段，模型首次调用常常不传，
     * {@link WebSearchArguments#getMaxResults()} 即为 {@code null}。原实现直接
     * {@code Integer.parseInt(null)} 抛 {@code NumberFormatException: Cannot parse null string}，
     * 使首次调用必失败、只有模型重试并恰好带上该字段才成功。现改为：缺失 / 空白 / 非法数字
     * 一律退化为 {@link WebSearchConfig#maxResult()}（配置上限）；只有模型显式请求更小的值才采纳。</p>
     *
     * @param arguments 待收敛的检索参数，允许为 {@code null}
     */
    private void applyMaxResultsLimit(WebSearchArguments arguments) {
        Integer limit = webSearchConfig == null ? null : webSearchConfig.maxResult();
        if (arguments == null || limit == null || limit <= 0) {
            return;
        }
        Integer requested = parseRequested(arguments.getMaxResults(), limit);
        if (requested == null || requested > limit) {
            arguments.setMaxResults(String.valueOf(limit));
        }
    }

    /**
     * 解析模型传入的 maxResults。
     *
     * @param raw   原始字符串，允许为 {@code null}
     * @param limit 配置上限，仅用于告警文案
     * @return 解析结果；缺失 / 空白 / 非法数字返回 {@code null} 并告警，绝不抛出
     */
    private Integer parseRequested(String raw, Integer limit) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Integer.valueOf(raw.trim());
        } catch (NumberFormatException e) {
            log.warn("web_search maxResults 非法('{}')，退化为配置上限 {}", raw, limit);
            return null;
        }
    }

    /**
     * 直接按 JSON 原文发起检索请求，不做任何参数加工。
     *
     * @param json 请求体 JSON
     * @return 检索服务的响应体
     * @throws IOException          HTTP 请求失败
     * @throws InterruptedException 请求被中断
     */
    public String search(String json) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .POST(
                        HttpRequest.BodyPublishers.ofString(json)
                )
                .header("Authorization", "Bearer " + this.webSearchConfig.apiKey())
                .uri(URI.create(this.webSearchConfig.baseUrl()))
                .timeout(Duration.ofSeconds(this.webSearchConfig.timeout()))
                .build();

        return httpClient.send(request, HttpResponse.BodyHandlers.ofString()).body();
    }
}
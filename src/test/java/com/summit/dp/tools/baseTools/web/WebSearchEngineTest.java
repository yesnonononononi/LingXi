package com.summit.dp.tools.baseTools.web;

import com.summit.dp.workflow.infrastructure.tools.web.WebSearchEngine;

import com.summit.dp.workflow.infrastructure.tools.web.WebSearchConfig;

import com.summit.dp.workflow.infrastructure.tools.web.WebResultSummarizer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workflow.infrastructure.tools.arguments.WebSearchArguments;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * {@link WebSearchEngine} 的单元测试，覆盖两块行为：
 *
 * <ol>
 *   <li><b>可选参数 maxResults 的收敛健壮性</b>：maxResults 是参数 schema 里的可选字段，
 *       模型首次调用常不传，原实现 Integer.parseInt(null) 抛 NumberFormatException 使首调必失败。
 *       这里断言 null / 空串 / 非法串三种输入均不抛异常，且请求体里的 max_results 收敛到配置上限。</li>
 *   <li><b>摘要触发阈值与降级</b>：原始结果长度 &lt;= maxOutput 的 110% 时不调用摘要器；
 *       超过阈值才摘要；摘要器返回 null 或抛异常时返回带标记的降级结果，且总长度 &lt;= maxOutput。</li>
 * </ol>
 *
 * <p>HTTP 层全部用 mock 的 HttpClient 返回构造好的 body 字符串，不发真实网络请求。</p>
 */
class WebSearchEngineTest {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    /** 与 CommonToolConfiguration#WEB_SEARCH_MAX_OUTPUT 同值，测试侧独立声明以免依赖装配类。 */
    private static final int MAX_OUTPUT = 3_000;

    /** 摘要触发阈值：maxOutput 的 110%（当前 3000 × 110% = 3300 字符），由被测代码的公开方法算，避免测试硬编码。 */
    private static final int THRESHOLD = WebSearchEngine.thresholdOf(MAX_OUTPUT);

    private static final String FALLBACK_PREFIX =
            WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER + WebSearchEngine.FALLBACK_BODY_SEPARATOR;

    private static WebSearchConfig configWithLimit(Integer maxResult) {
        return WebSearchConfig.builder()
                .baseUrl("http://localhost/web-search")
                .apiKey("test-key")
                .maxResult(maxResult)
                .maxOutput(MAX_OUTPUT)
                .timeout(5L)
                .build();
    }

    /** 构造长度精确为 length 的 body 字符串，用来卡阈值边界。 */
    private static String bodyOfLength(int length) {
        return "x".repeat(length);
    }

    /** mock HttpClient，固定返回给定 body。 */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static HttpClient httpClientReturning(String body) throws Exception {
        HttpClient client = mock(HttpClient.class);
        HttpResponse<String> response = mock(HttpResponse.class);
        when(response.body()).thenReturn(body);
        doReturn(response).when(client).send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class));
        return client;
    }

    /** 摘要器替身：默认返回 null，由各用例显式打桩。 */
    private static WebResultSummarizer mockSummarizer() {
        return mock(WebResultSummarizer.class);
    }

    /** 装配被测引擎（maxResults 上限 3，maxOutput 与工具定义同值）。 */
    private static WebSearchEngine engineWith(HttpClient httpClient, WebResultSummarizer summarizer) {
        return new WebSearchEngine(configWithLimit(3), httpClient, OBJECT_MAPPER, summarizer);
    }

    // ------------------------------------------------------------------
    // 1. maxResults 收敛（原有 5 个用例；body 取 {} 长度 2，不触发摘要）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("maxResults 为 null 时不抛异常，且请求体 max_results 取配置上限")
    void nullMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(httpClientReturning("{}"), mockSummarizer());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").build();

        String result = assertDoesNotThrow(() -> engine.search(arguments));

        assertEquals("{}", result);
        assertEquals("3", arguments.getMaxResults());
        assertTrue(OBJECT_MAPPER.writeValueAsString(arguments).contains("\"max_results\":\"3\""));
    }

    @Test
    @DisplayName("maxResults 为空串时不抛异常，且请求体 max_results 取配置上限")
    void blankMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(httpClientReturning("{}"), mockSummarizer());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("   ").build();

        assertDoesNotThrow(() -> engine.search(arguments));

        assertEquals("3", arguments.getMaxResults());
        assertTrue(OBJECT_MAPPER.writeValueAsString(arguments).contains("\"max_results\":\"3\""));
    }

    @Test
    @DisplayName("maxResults 为非法数字串时不抛异常，退化为配置上限")
    void invalidMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(httpClientReturning("{}"), mockSummarizer());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("abc").build();

        assertDoesNotThrow(() -> engine.search(arguments));

        assertEquals("3", arguments.getMaxResults());
    }

    @Test
    @DisplayName("maxResults 小于上限时保留模型请求值")
    void smallerMaxResultsIsKept() throws Exception {
        WebSearchEngine engine = engineWith(httpClientReturning("{}"), mockSummarizer());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("1").build();

        engine.search(arguments);

        assertEquals("1", arguments.getMaxResults());
    }

    @Test
    @DisplayName("maxResults 大于上限时收敛到配置上限")
    void largerMaxResultsIsClamped() throws Exception {
        WebSearchEngine engine = engineWith(httpClientReturning("{}"), mockSummarizer());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("10").build();

        engine.search(arguments);

        assertEquals("3", arguments.getMaxResults());
    }
    // ------------------------------------------------------------------
    // 2. 摘要触发阈值
    // ------------------------------------------------------------------

    @Test
    @DisplayName("原始结果长度严格等于阈值时不调用摘要器，原样返回")
    void resultAtThresholdIsReturnedVerbatimWithoutSummarizing() throws Exception {
        String body = bodyOfLength(THRESHOLD);
        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        // 关键断言：阈值内绝不调用模型（变异测试靶点）。
        verifyNoInteractions(summarizer);
    }

    @Test
    @DisplayName("原始结果长度远小于阈值时同样不调用摘要器")
    void shortResultIsReturnedVerbatimWithoutSummarizing() throws Exception {
        String body = bodyOfLength(20);
        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        verify(summarizer, never()).summary(anyString());
    }

    @Test
    @DisplayName("原始结果长度超过阈值一个字符时调用摘要器，并返回摘要结果")
    void resultAboveThresholdIsSummarized() throws Exception {
        String body = bodyOfLength(THRESHOLD + 1);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn("SUMMARY-TEXT");
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals("SUMMARY-TEXT", result);
        verify(summarizer, times(1)).summary(body);
    }

    @Test
    @DisplayName("阈值随 maxOutput 变化：maxOutput 翻倍后同一长度的原始结果不再触发摘要")
    void thresholdFollowsConfiguredMaxOutput() throws Exception {
        String body = bodyOfLength(THRESHOLD + 1);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn("SUMMARY-TEXT");
        WebSearchConfig doubled = WebSearchConfig.builder()
                .baseUrl("http://localhost/web-search")
                .apiKey("test-key")
                .maxResult(3)
                .maxOutput(MAX_OUTPUT * 2)
                .timeout(5L)
                .build();
        WebSearchEngine engine = new WebSearchEngine(doubled, httpClientReturning(body), OBJECT_MAPPER, summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        verifyNoInteractions(summarizer);
        assertEquals(MAX_OUTPUT * 2 * 11 / 10, WebSearchEngine.thresholdOf(MAX_OUTPUT * 2));
    }
    // ------------------------------------------------------------------
    // 3. 摘要失败降级
    // ------------------------------------------------------------------

    @Test
    @DisplayName("摘要器返回 null 时降级：带标记 + 裁剪，总长度不超过 maxOutput")
    void nullSummaryFallsBackToMarkedAndTruncatedOriginal() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 3);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn(null);
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertTrue(result.startsWith(WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER), "降级结果必须以标记开头");
        assertTrue(result.length() <= MAX_OUTPUT, "降级结果长度必须 <= maxOutput，实际=" + result.length());
        assertEquals(MAX_OUTPUT, result.length());
        // 预算精确：标记（含分隔符）+ 剩余预算全部给原文
        assertEquals(FALLBACK_PREFIX + body.substring(0, MAX_OUTPUT - FALLBACK_PREFIX.length()), result);
        verify(summarizer, times(1)).summary(body);
    }

    @Test
    @DisplayName("结果长度落在 (maxOutput, 阈值] 区间时不摘要、原样返回（110% 规则的独有语义）")
    void resultBetweenMaxOutputAndThresholdIsReturnedVerbatim() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT + 1);
        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        assertTrue(result.length() > MAX_OUTPUT, "轻微超限按 110% 契约原样返回，实际=" + result.length());
        verifyNoInteractions(summarizer);
    }

    @Test
    @DisplayName("摘要器抛异常时由引擎兜底降级：带标记，长度不超过 maxOutput")
    void summarizerExceptionFallsBackSafely() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 2);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenThrow(new IllegalStateException("compact model unavailable"));
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = assertDoesNotThrow(() -> engine.search(WebSearchArguments.builder().query("lingxi").build()));

        assertTrue(result.startsWith(WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER));
        assertTrue(result.length() <= MAX_OUTPUT, "降级结果长度必须 <= maxOutput，实际=" + result.length());
    }

    @Test
    @DisplayName("真实摘要器在模型不可用时返回 null（内部把异常转 null，而不是返回原始内容）")
    void realSummarizerReturnsNullInsteadOfRawContent() {
        WebResultSummarizer summarizer = new WebResultSummarizer(null);

        assertNull(summarizer.summary(bodyOfLength(THRESHOLD + 1)));
        assertNull(summarizer.summary(null));
        assertNull(summarizer.summary("   "));
    }

    @Test
    @DisplayName("引擎收到空 body 时不摘要，直接返回原样")
    void emptyBodyIsReturnedWithoutSummarizing() throws Exception {
        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = engineWith(httpClientReturning(""), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals("", result);
        assertFalse(result.contains(WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER));
        verifyNoInteractions(summarizer);
    }

    // ------------------------------------------------------------------
    // 4. 降级裁剪的代理对保护（truncate 内的 end-- 分支）
    // ------------------------------------------------------------------

    /**
     * 构造 bad case：降级分支会调用 {@code truncate(original, bodyBudget)}，
     * 把 body 设计成 "a"*(bodyBudget-1) + "😀" + "b"*N，
     * 使裁剪边界 {@code bodyBudget - 1} 处正好是 emoji 的高位代理。
     * 若 {@code truncate} 缺少 {@code end--} 保护，结果会以半个字符（孤立高位代理）结尾。
     */
    @Test
    @DisplayName("降级裁剪边界落在 emoji 中间时，不会切出半个代理对字符")
    void fallbackTruncationDoesNotSplitSurrogatePair() throws Exception {
        int bodyBudget = MAX_OUTPUT - FALLBACK_PREFIX.length();
        String emoji = "\uD83D\uDE00"; // 该 emoji 在 UTF-16 中占 2 个 char
        // 保证 body.length() > bodyBudget 且 body.charAt(bodyBudget - 1) 是高位代理
        String body = "a".repeat(bodyBudget - 1) + emoji + "b".repeat(MAX_OUTPUT);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn(null);
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertTrue(result.startsWith(WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER), "必须走降级分支");
        assertTrue(result.length() <= MAX_OUTPUT, "降级结果长度必须 <= maxOutput，实际=" + result.length());
        // 关键断言：末尾不能是孤立高位代理（即不能切出半个 emoji）
        assertFalse(Character.isHighSurrogate(result.charAt(result.length() - 1)),
                "裁剪结果以高位代理结尾，说明 emoji 被切成了半个字符");
        // 收紧断言：预算比 bodyBudget 少 1，emoji 整体丢弃
        assertEquals(FALLBACK_PREFIX + "a".repeat(bodyBudget - 1), result);
        verify(summarizer, times(1)).summary(body);
    }

    @Test
    @DisplayName("降级裁剪边界正好落在完整 emoji 之后时，结果仍是完整字符")
    void fallbackTruncationAtSurrogateBoundaryKeepsWholeChars() throws Exception {
        int bodyBudget = MAX_OUTPUT - FALLBACK_PREFIX.length();
        String emoji = "\uD83D\uDE00";
        // 边界前一格是 emoji 的低位代理：无需回退，但结果也不能是残片
        String body = "a".repeat(bodyBudget - 2) + emoji + "b".repeat(MAX_OUTPUT);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn(null);
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertTrue(result.length() <= MAX_OUTPUT);
        assertFalse(Character.isHighSurrogate(result.charAt(result.length() - 1)),
                "结果不能以高位代理结尾");
        assertEquals(FALLBACK_PREFIX + "a".repeat(bodyBudget - 2) + emoji, result);
    }

    // ------------------------------------------------------------------
    // 5. maxOutput 未配置（null / 0 / 负数）：不摘要、原样返回超长内容
    // ------------------------------------------------------------------

    private static WebSearchConfig configWithMaxOutput(Integer maxOutput) {
        return WebSearchConfig.builder()
                .baseUrl("http://localhost/web-search")
                .apiKey("test-key")
                .maxResult(3)
                .maxOutput(maxOutput)
                .timeout(5L)
                .build();
    }

    @Test
    @DisplayName("maxOutput 为 null 时视为未配置：归一为 0，不调用摘要器，原样返回超长内容")
    void nullMaxOutputReturnsRawContentWithoutSummarizing() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 3);
        WebSearchConfig config = configWithMaxOutput(null);
        // 规范化构造：null 归一为 0（未配置）
        assertEquals(0, config.maxOutput().intValue());

        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = new WebSearchEngine(config, httpClientReturning(body), OBJECT_MAPPER, summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result, "未配置 maxOutput 时必须原样返回");
        assertTrue(result.length() > MAX_OUTPUT, "契约明确允许未配置时输出超过上限，实际=" + result.length());
        verifyNoInteractions(summarizer);
    }

    @Test
    @DisplayName("maxOutput 为 0 时同样视为未配置：不调用摘要器，原样返回超长内容")
    void zeroMaxOutputReturnsRawContentWithoutSummarizing() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 3);
        WebSearchConfig config = configWithMaxOutput(0);
        assertEquals(0, config.maxOutput().intValue());

        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = new WebSearchEngine(config, httpClientReturning(body), OBJECT_MAPPER, summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        assertTrue(result.length() > MAX_OUTPUT, "实际=" + result.length());
        verifyNoInteractions(summarizer);
    }

    @Test
    @DisplayName("maxOutput 为负数时归一为 0，不摘要、原样返回")
    void negativeMaxOutputReturnsRawContentWithoutSummarizing() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 3);
        WebSearchConfig config = configWithMaxOutput(-100);
        assertEquals(0, config.maxOutput().intValue());

        WebResultSummarizer summarizer = mockSummarizer();
        WebSearchEngine engine = new WebSearchEngine(config, httpClientReturning(body), OBJECT_MAPPER, summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertEquals(body, result);
        verifyNoInteractions(summarizer);
    }

    // ------------------------------------------------------------------
    // 6. 摘要器返回空白串（非 null）：必须走降级，不能把空白当摘要
    // ------------------------------------------------------------------

    @Test
    @DisplayName("摘要器返回空白串时走降级分支，不会把空白当摘要返回")
    void blankSummaryFallsBackToMarkedAndTruncatedOriginal() throws Exception {
        String body = bodyOfLength(MAX_OUTPUT * 2);
        WebResultSummarizer summarizer = mockSummarizer();
        when(summarizer.summary(anyString())).thenReturn("   ");
        WebSearchEngine engine = engineWith(httpClientReturning(body), summarizer);

        String result = engine.search(WebSearchArguments.builder().query("lingxi").build());

        assertTrue(result.startsWith(WebSearchEngine.SUMMARY_UNAVAILABLE_MARKER),
                "空白摘要必须走降级分支");
        assertFalse("   ".equals(result), "不能把空白串当摘要返回");
        assertFalse(result.isBlank(), "降级结果不应是空白");
        assertTrue(result.length() <= MAX_OUTPUT, "降级结果长度必须 <= maxOutput，实际=" + result.length());
        assertEquals(FALLBACK_PREFIX + body.substring(0, MAX_OUTPUT - FALLBACK_PREFIX.length()), result);
        verify(summarizer, times(1)).summary(body);
    }
}
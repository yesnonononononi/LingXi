package com.summit.dp.tools.baseTools.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.tools.baseTools.arguments.WebSearchArguments;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * {@link WebSearchEngine} 对可选参数 {@code maxResults} 的健壮性测试。
 *
 * <p>覆盖缺陷C：{@code maxResults} 是参数 schema 里的可选字段，模型首次调用常不传，
 * 原实现 {@code Integer.parseInt(null)} 抛 {@code NumberFormatException} 使首调必失败。
 * 这里断言 null / 空串 / 非法串三种输入均不抛异常，且请求体里的 {@code max_results}
 * 收敛到配置上限。</p>
 */
class WebSearchEngineTest {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private static WebSearchConfig configWithLimit(Integer maxResult) {
        return WebSearchConfig.builder()
                .baseUrl("http://localhost/web-search")
                .apiKey("test-key")
                .maxResult(maxResult)
                .timeout(5L)
                .build();
    }

    /** 以测试替身替掉真实 HttpClient 与摘要模型，聚焦被测的 maxResults 收敛逻辑。 */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private static WebSearchEngine engineWith(HttpClient httpClient) {
        // 摘要替身：直接回显，避免依赖真实 ChatModel。
        WebResultSummarizer summarizer = new WebResultSummarizer(null) {
            @Override
            public String summary(String webSearchResultStr) {
                return "SUMMARY:" + webSearchResultStr;
            }
        };
        return new WebSearchEngine(configWithLimit(3), httpClient, OBJECT_MAPPER, summarizer);
    }

    private static HttpClient okHttpClient() throws Exception {
        HttpClient client = mock(HttpClient.class);
        HttpResponse<String> response = mock(HttpResponse.class);
        when(response.body()).thenReturn("{}");
        doReturn(response).when(client).send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class));
        return client;
    }

    @Test
    @DisplayName("maxResults 为 null 时不抛异常，且请求体 max_results 取配置上限")
    void nullMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(okHttpClient());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").build();

        String result = assertDoesNotThrow(() -> engine.search(arguments));

        assertTrue(result.startsWith("SUMMARY:"), result);
        assertEquals("3", arguments.getMaxResults());
        assertTrue(OBJECT_MAPPER.writeValueAsString(arguments).contains("\"max_results\":\"3\""));
    }

    @Test
    @DisplayName("maxResults 为空串时不抛异常，且请求体 max_results 取配置上限")
    void blankMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(okHttpClient());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("   ").build();

        assertDoesNotThrow(() -> engine.search(arguments));

        assertEquals("3", arguments.getMaxResults());
        assertTrue(OBJECT_MAPPER.writeValueAsString(arguments).contains("\"max_results\":\"3\""));
    }

    @Test
    @DisplayName("maxResults 为非法数字串时不抛异常，退化为配置上限")
    void invalidMaxResultsFallsBackToConfiguredLimit() throws Exception {
        WebSearchEngine engine = engineWith(okHttpClient());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("abc").build();

        assertDoesNotThrow(() -> engine.search(arguments));

        assertEquals("3", arguments.getMaxResults());
    }

    @Test
    @DisplayName("maxResults 小于上限时保留模型请求值")
    void smallerMaxResultsIsKept() throws Exception {
        WebSearchEngine engine = engineWith(okHttpClient());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("1").build();

        engine.search(arguments);

        assertEquals("1", arguments.getMaxResults());
    }

    @Test
    @DisplayName("maxResults 大于上限时收敛到配置上限")
    void largerMaxResultsIsClamped() throws Exception {
        WebSearchEngine engine = engineWith(okHttpClient());
        WebSearchArguments arguments = WebSearchArguments.builder().query("lingxi").maxResults("10").build();

        engine.search(arguments);

        assertEquals("3", arguments.getMaxResults());
    }
}

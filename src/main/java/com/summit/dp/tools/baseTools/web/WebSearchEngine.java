package com.summit.dp.tools.baseTools.web;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.tools.baseTools.arguments.WebSearchArguments;

import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

@Slf4j
@AllArgsConstructor
public class WebSearchEngine {
    private final WebSearchConfig webSearchConfig;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final WebResultSummarizer webResultSummarizer;

    public String search(WebSearchArguments arguments) throws IOException, InterruptedException {
        applyMaxResultsLimit(arguments);
        return webResultSummarizer.summary(this.search(this.objectMapper.writeValueAsString(arguments)));
    }

    /**
     * 把可选的 {@code maxResults} 收敛为配置上限，避免"模型未传"直接进入数字解析。
     *
     * <p><b>缺陷C</b>：{@code maxResults} 在参数 JSON schema 里是可选字段，模型首次调用常常不传，
     * {@link WebSearchArguments#getMaxResults()} 即为 {@code null}。原实现直接
     * {@code Integer.parseInt(null)} 抛 {@code NumberFormatException: Cannot parse null string}，
     * 使首次调用必失败、只有模型重试并恰好带上该字段才成功。现改为：缺失 / 空白 / 非法数字
     * 一律退化为 {@link WebSearchConfig#maxResult()}（配置上限）；只有模型显式请求更小的值才采纳。</p>
     */
    private void applyMaxResultsLimit(WebSearchArguments arguments) {
        Integer limit = webSearchConfig.maxResult();
        if (arguments == null || limit == null || limit <= 0) {
            return;
        }
        Integer requested = parseRequested(arguments.getMaxResults(), limit);
        if (requested == null || requested > limit) {
            arguments.setMaxResults(String.valueOf(limit));
        }
    }

    /** 解析模型传入的 maxResults；缺失 / 空白 / 非法数字返回 {@code null} 并告警，绝不抛出。 */
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

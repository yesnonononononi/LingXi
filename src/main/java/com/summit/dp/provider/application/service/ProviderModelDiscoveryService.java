package com.summit.dp.provider.application.service;

import com.summit.dp.provider.application.vo.RemoteModelVO;
import com.summit.dp.provider.domain.model.ProviderConfig;
import com.summit.dp.provider.domain.repo.ProviderConfigRepository;
import com.summit.dp.shared.exception.ClientException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.TreeSet;
import java.util.Set;

/** 密钥留在服务端，发现失败时由界面保留手动输入入口。 */
@Service
@RequiredArgsConstructor
public class ProviderModelDiscoveryService {
    private final ProviderConfigRepository repository;
    private final ObjectMapper objectMapper;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER).build();

    public List<RemoteModelVO> discover(Long providerConfigId, String baseUrl, String apiKey) {
        ProviderConfig provider = providerConfigId == null ? null
                : repository.findById(providerConfigId).orElseThrow(ClientException::new);
        String url = baseUrl == null && provider != null ? provider.getBaseUrl() : baseUrl;
        String key = (apiKey == null || apiKey.isBlank()) && provider != null ? provider.getApiKey() : apiKey;
        throwIf(provider != null && key != null && key.equals(provider.getMaskedApiKey()), "请填写真实 API Key，不能使用掩码");
        throwIf(url == null || url.isBlank(), "请先填写提供商的 API Base URL");
        URI endpoint;
        try {
            endpoint = URI.create(url.trim().replaceAll("/+$", "") + "/models");
        } catch (IllegalArgumentException exception) {
            throw new ClientException("提供商的 API Base URL 格式不正确");
        }
        throwIf(!List.of("http", "https").contains(endpoint.getScheme()) || endpoint.getHost() == null
                || endpoint.getUserInfo() != null || endpoint.getQuery() != null || endpoint.getFragment() != null,
                "API Base URL 必须是 HTTP 或 HTTPS 地址，且不能包含账号、查询参数或片段");
        throwIf(key != null && (key.contains("\r") || key.contains("\n")), "API Key 不能包含换行");
        HttpRequest.Builder request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(15))
                .header("Accept", "application/json").GET();
        if (key != null && !key.isBlank()) request.header("Authorization", "Bearer " + key.trim());
        try {
            HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
            // 不回传远端响应体，防止中转接口把密钥或内部信息带到界面。
            throwIf(response.statusCode() < 200 || response.statusCode() >= 300,
                    "获取模型列表失败（HTTP " + response.statusCode() + "），请检查地址和密钥，或手动输入模型名称");
            JsonNode body = objectMapper.readTree(response.body());
            JsonNode data = body == null ? null : body.get("data");
            throwIf(data == null || !data.isArray(), "提供商未返回兼容的模型列表，请手动输入模型名称");
            Set<String> names = new TreeSet<>();
            for (JsonNode item : data) {
                JsonNode id = item.get("id");
                if (id != null && id.isTextual() && !id.asText().isBlank()) names.add(id.asText().trim());
            }
            return names.stream().map(RemoteModelVO::new).toList();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new ClientException("获取模型列表已中断，请重试或手动输入模型名称");
        } catch (IOException exception) {
            throw new ClientException("无法连接提供商或模型列表格式不正确，请检查连接，或手动输入模型名称");
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

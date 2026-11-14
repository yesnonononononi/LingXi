package com.summit.dp.mcp.infrastructure.oauth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * MCP 授权规范里与网络打交道的部分：资源元数据发现、授权服务器元数据、客户端注册、令牌端点。
 *
 * <p>只做协议搬运，不持有任何状态：谁持有令牌、什么时候刷新，由 {@link McpOAuthEngine} 决定。
 * 每个发现步骤都允许失败，失败只让探测回落到下一个候选地址。</p>
 */
@Slf4j
@Component
public class OAuthMetadataClient {

    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(15);
    private static final String RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
    private static final String AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
    private static final String OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";

    /** RFC 9728：受保护资源元数据，只取本流程用到的两项 */
    public record ResourceMetadata(String authorizationServer, List<String> scopesSupported) {}

    /** RFC 8414 / OIDC：授权服务器元数据 */
    public record ServerMetadata(String issuer, String authorizationEndpoint, String tokenEndpoint,
                                 String registrationEndpoint, List<String> scopesSupported) {}

    /** 令牌端点响应；{@code expiresInSeconds} 缺失时为 0，由调用方决定退避 */
    public record TokenResponse(String accessToken, String refreshToken, long expiresInSeconds, String scope) {}

    private final ObjectMapper json;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(REQUEST_TIMEOUT).build();

    public OAuthMetadataClient(ObjectMapper json) {
        this.json = json;
    }

    /**
     * 找到资源元数据。
     *
     * <p>优先用 401 的 {@code WWW-Authenticate} 里给出的地址——服务端既然指明了就别再猜；
     * 没有挑战信息时按 RFC 9728 的固定位置探测（先带路径，再退到站点根）。</p>
     *
     * @param mcpUrl               配置的服务地址
     * @param resourceMetadataHint 401 响应里给出的 resource_metadata 地址，可为 null
     */
    public Optional<ResourceMetadata> discoverResource(String mcpUrl, String resourceMetadataHint) {
        for (String candidate : resourceMetadataCandidates(mcpUrl, resourceMetadataHint)) {
            Optional<ResourceMetadata> metadata = getJson(candidate).flatMap(this::toResourceMetadata);
            if (metadata.isPresent()) {
                return metadata;
            }
        }
        return Optional.empty();
    }

    /** @return 授权服务器元数据；候选位置都不通时为空 */
    public Optional<ServerMetadata> discoverServer(String authorizationServer) {
        List<String> candidates = new ArrayList<>();
        candidates.add(trimTrailingSlash(authorizationServer) + AUTHORIZATION_SERVER_PATH);
        String origin = originOf(authorizationServer);
        if (origin != null) {
            candidates.add(origin + AUTHORIZATION_SERVER_PATH);
            candidates.add(origin + OPENID_CONFIGURATION_PATH);
        }
        for (String candidate : candidates) {
            Optional<ServerMetadata> metadata = getJson(candidate).flatMap(this::toServerMetadata);
            if (metadata.isPresent()) {
                return metadata;
            }
        }
        return Optional.empty();
    }

    /**
     * 动态注册客户端（RFC 7591）。
     *
     * <p>用 {@code token_endpoint_auth_method=none} 配合 PKCE：桌面应用没有能保守住的密钥，
     * 在这里声明成机密客户端只是自欺欺人。</p>
     *
     * @return 授权服务器下发的 client_id；未开放注册端点时为空
     */
    public Optional<String> registerClient(ServerMetadata server, String redirectUri) {
        if (server.registrationEndpoint() == null || server.registrationEndpoint().isBlank()) {
            return Optional.empty();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_name", "LingXi");
        body.put("redirect_uris", List.of(redirectUri));
        body.put("grant_types", List.of("authorization_code", "refresh_token"));
        body.put("response_types", List.of("code"));
        body.put("token_endpoint_auth_method", "none");
        return postJson(server.registrationEndpoint(), body)
                .map(node -> node.path("client_id").asText(null))
                .filter(clientId -> !clientId.isBlank());
    }

    /** 用授权码换令牌 */
    public Optional<TokenResponse> exchangeCode(ServerMetadata server, String clientId, String code,
                                                String codeVerifier, String redirectUri, String resource) {
        Map<String, Object> form = new LinkedHashMap<>();
        form.put("grant_type", "authorization_code");
        form.put("code", code);
        form.put("redirect_uri", redirectUri);
        form.put("client_id", clientId);
        form.put("code_verifier", codeVerifier);
        if (resource != null) {
            form.put("resource", resource);
        }
        return postForm(server.tokenEndpoint(), form).flatMap(this::toTokenResponse);
    }

    /** 用刷新令牌换新的访问令牌 */
    public Optional<TokenResponse> refresh(String tokenEndpoint, String clientId, String refreshToken, String resource) {
        Map<String, Object> form = new LinkedHashMap<>();
        form.put("grant_type", "refresh_token");
        form.put("refresh_token", refreshToken);
        form.put("client_id", clientId);
        if (resource != null) {
            form.put("resource", resource);
        }
        return postForm(tokenEndpoint, form).flatMap(this::toTokenResponse);
    }

    private List<String> resourceMetadataCandidates(String mcpUrl, String hint) {
        List<String> candidates = new ArrayList<>();
        if (hint != null && !hint.isBlank()) {
            candidates.add(hint.trim());
        }
        URI uri = URI.create(mcpUrl.trim());
        String origin = uri.getScheme() + "://" + uri.getRawAuthority();
        String path = uri.getRawPath() == null ? "" : trimTrailingSlash(uri.getRawPath());
        candidates.add(origin + RESOURCE_METADATA_PATH + path);
        candidates.add(origin + RESOURCE_METADATA_PATH);
        return candidates.stream().distinct().toList();
    }

    private Optional<ResourceMetadata> toResourceMetadata(JsonNode node) {
        JsonNode servers = node.path("authorization_servers");
        if (!servers.isArray() || servers.isEmpty()) {
            return Optional.empty();
        }
        String authorizationServer = servers.get(0).asText(null);
        if (authorizationServer == null || authorizationServer.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new ResourceMetadata(authorizationServer, readStringArray(node.path("scopes_supported"))));
    }

    private Optional<ServerMetadata> toServerMetadata(JsonNode node) {
        String authorizationEndpoint = node.path("authorization_endpoint").asText(null);
        String tokenEndpoint = node.path("token_endpoint").asText(null);
        if (authorizationEndpoint == null || authorizationEndpoint.isBlank()
                || tokenEndpoint == null || tokenEndpoint.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new ServerMetadata(node.path("issuer").asText(null), authorizationEndpoint, tokenEndpoint,
                node.path("registration_endpoint").asText(null), readStringArray(node.path("scopes_supported"))));
    }

    private Optional<TokenResponse> toTokenResponse(JsonNode node) {
        String accessToken = node.path("access_token").asText(null);
        if (accessToken == null || accessToken.isBlank()) {
            log.warn("MCP 令牌端点未返回 access_token");
            return Optional.empty();
        }
        return Optional.of(new TokenResponse(accessToken, node.path("refresh_token").asText(null),
                node.path("expires_in").asLong(0), node.path("scope").asText(null)));
    }

    private Optional<JsonNode> getJson(String url) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(REQUEST_TIMEOUT)
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            return send(request);
        } catch (IllegalArgumentException invalid) {
            log.debug("MCP 授权元数据地址不合法: url={}", url);
            return Optional.empty();
        }
    }

    private Optional<JsonNode> postJson(String url, Map<String, Object> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(REQUEST_TIMEOUT)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                    .build();
            return send(request);
        } catch (Exception failure) {
            log.warn("MCP 客户端注册请求失败: url={}", url, failure);
            return Optional.empty();
        }
    }

    private Optional<JsonNode> postForm(String url, Map<String, Object> form) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(REQUEST_TIMEOUT)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(encodeForm(form)))
                    .build();
            return send(request);
        } catch (Exception failure) {
            log.warn("MCP 令牌端点请求失败: url={}", url, failure);
            return Optional.empty();
        }
    }

    private Optional<JsonNode> send(HttpRequest request) {
        try {
            HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.debug("MCP 授权请求被拒绝: url={}, status={}", request.uri(), response.statusCode());
                return Optional.empty();
            }
            return Optional.of(json.readTree(response.body()));
        } catch (IOException failure) {
            log.debug("MCP 授权请求失败: url={}", request.uri(), failure);
            return Optional.empty();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }

    private static String encodeForm(Map<String, Object> form) {
        StringBuilder encoded = new StringBuilder();
        for (Map.Entry<String, Object> entry : form.entrySet()) {
            if (encoded.length() > 0) {
                encoded.append('&');
            }
            encoded.append(URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(String.valueOf(entry.getValue()), StandardCharsets.UTF_8));
        }
        return encoded.toString();
    }

    private static List<String> readStringArray(JsonNode node) {
        List<String> values = new ArrayList<>();
        if (!node.isArray()) {
            return values;
        }
        node.forEach(element -> {
            String value = element.asText(null);
            if (value != null && !value.isBlank()) {
                values.add(value);
            }
        });
        return values;
    }

    private static String originOf(String url) {
        try {
            URI uri = URI.create(url.trim());
            return uri.getRawAuthority() == null ? null : uri.getScheme() + "://" + uri.getRawAuthority();
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    private static String trimTrailingSlash(String url) {
        String trimmed = url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}

package com.summit.dp.mcp.infrastructure.oauth;

import com.summit.dp.mcp.application.service.McpAuthorizationGateway;
import com.summit.dp.mcp.domain.model.McpAuth;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * OAuth 授权流程的唯一编排点：发现、注册、PKCE、回调、换令牌、刷新。
 *
 * <p>授权是<b>显式</b>的：一次连接遇到 401 只会把状态标成「需要授权」，流程由用户在界面上点击触发。
 * 401 里阻塞等用户意味着一个 HTTP 请求要挂几分钟——前端超时、启动注册挂起，
 * 全都踩上了。</p>
 *
 * <p>同一服务的授权与刷新都要单飞：401 会同时来自握手、工具发现、健康检查和工具调用，
 * 不串行化就是多个浏览器窗口互相覆盖令牌。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class McpOAuthEngine implements McpAuthorizationGateway {

    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_AUTHORIZED = "AUTHORIZED";
    public static final String STATUS_FAILED = "FAILED";

    /** 用户在浏览器里完成授权并回跳的总时限 */
    private static final Duration CALLBACK_TIMEOUT = Duration.ofMinutes(5);
    /** 到期前这段时间就提前刷新，避免踩在边界上失败 */
    private static final long REFRESH_SKEW_MILLIS = 60_000L;
    private static final int SECRET_BYTES = 32;

    private final OAuthMetadataClient metadataClient;
    private final McpTokenStore tokenStore;

    private final Map<String, PendingAuthorization> pending = new ConcurrentHashMap<>();
    /** 401 响应里的 {@code WWW-Authenticate} 给出的资源元数据地址，按服务缓存 */
    private final Map<String, String> resourceMetadataHints = new ConcurrentHashMap<>();
    private final Map<String, String> statuses = new ConcurrentHashMap<>();
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    /** 进行一次授权所必需、但回调结束前只存在于内存中的东西 */
    private record PendingAuthorization(String state, String codeVerifier, LoopbackCallbackServer loopback,
                                        OAuthMetadataClient.ServerMetadata server, String clientId, String resource,
                                        String authorizationUrl, Instant expiresAt) {

        boolean isExpired() {
            return Instant.now().isAfter(expiresAt);
        }
    }

    /** @return 当前可用的访问令牌；没有或已在刷新边界内时为 null */
    public String resolveAccessToken(String serverName) {
        return tokenStore.find(serverName)
                .filter(token -> !token.accessToken().isBlank() && !token.isExpiring(REFRESH_SKEW_MILLIS))
                .map(McpTokenStore.StoredToken::accessToken)
                .orElse(null);
    }

    /** @return 当前是否有可用令牌 */
    public boolean hasUsableToken(String serverName) {
        return resolveAccessToken(serverName) != null;
    }

    /** @return 授权状态，从未发起过授权时为 null */
    public String resolveStatus(String serverName) {
        return statuses.get(serverName);
    }

    /** @return 正在等待用户授权的地址；没有在途授权时为 null */
    public String resolveAuthorizationUrl(String serverName) {
        PendingAuthorization active = pending.get(serverName);
        return active == null || active.isExpired() ? null : active.authorizationUrl();
    }

    /**
     * 记下服务端在 401 里给出的资源元数据地址。
     *
     * <p>服务端既然指明了资源元数据位置，就不该再按固定路径去猜——猜错会走到另一个授权服务器，
     * 签出来的令牌受众不对，回头还是 401。</p>
     */
    public void noteChallenge(String serverName, String wwwAuthenticate) {
        if (wwwAuthenticate == null || wwwAuthenticate.isBlank()) {
            return;
        }
        String hint = parseResourceMetadata(wwwAuthenticate);
        if (hint != null) {
            resourceMetadataHints.put(serverName, hint);
        }
    }

    /**
     * 发起授权，返回需要用户在浏览器里打开的地址。
     *
     * <p>步骤顺序不可调整：客户端的 {@code redirect_uri} 必须带回调端口，所以回调服务要先起；
     * 而没有客户端标识就拼不出授权地址，所以注册必须在拼 URL 之前。</p>
     *
     * @param serverName 服务名，令牌按它保存
     * @param mcpUrl     服务地址，同时作为授权请求的 resource
     * @param auth       服务配置的认证方式
     * @return 授权地址
     */
    public String beginAuthorization(String serverName, String mcpUrl, McpAuth auth) {
        throwIf(serverName == null || serverName.isBlank(), "MCP 服务名不能为空");
        throwIf(!auth.isOauth(), "该 MCP 服务未启用 OAuth 认证");
        throwIf(mcpUrl == null || mcpUrl.isBlank(), "服务地址不能为空");

        synchronized (lock(serverName)) {
            PendingAuthorization active = pending.get(serverName);
            if (active != null && !active.isExpired()) {
                return active.authorizationUrl();
            }
            closePending(serverName);

            OAuthMetadataClient.ResourceMetadata resource = metadataClient
                    .discoverResource(mcpUrl, resourceMetadataHints.get(serverName))
                    .orElseThrow(() -> new ClientException("无法从该服务发现授权服务器，请确认它支持 OAuth 授权"));
            OAuthMetadataClient.ServerMetadata server = metadataClient
                    .discoverServer(auth.authorizationServer() == null
                            ? resource.authorizationServer() : auth.authorizationServer())
                    .orElseThrow(() -> new ClientException("无法获取授权服务器元数据，请检查授权服务器地址"));

            String state = randomSecret();
            LoopbackCallbackServer loopback = LoopbackCallbackServer.start(state);
            String clientId = resolveClientId(serverName, server, loopback.redirectUri());
            String codeVerifier = randomSecret();
            List<String> scopes = auth.scopes().isEmpty() ? resource.scopesSupported() : auth.scopes();
            String authorizationUrl = buildAuthorizationUrl(server, clientId, loopback.redirectUri(),
                    state, codeChallenge(codeVerifier), scopes, mcpUrl);

            PendingAuthorization authorization = new PendingAuthorization(state, codeVerifier, loopback, server,
                    clientId, mcpUrl, authorizationUrl, Instant.now().plus(CALLBACK_TIMEOUT));
            pending.put(serverName, authorization);
            statuses.put(serverName, STATUS_PENDING);
            log.info("发起 MCP 授权: name={}, as={}", serverName, server.authorizationEndpoint());
            Thread.ofVirtual().name("mcp-oauth-" + serverName)
                    .start(() -> awaitAuthorization(serverName, authorization));
            return authorizationUrl;
        }
    }

    /**
     * 用刷新令牌静默续期。
     *
     * <p>刷新失败会清掉令牌并把状态打回「需要授权」：吊销比过期更常见，留着坏令牌只会让每次连接
     * 都重跑一遍 401。</p>
     *
     * @return 是否拿到了新的访问令牌
     */
    public boolean refresh(String serverName) {
        McpTokenStore.StoredToken token = tokenStore.find(serverName).orElse(null);
        if (token == null || token.refreshToken() == null || token.tokenEndpoint() == null) {
            return false;
        }
        synchronized (lock(serverName)) {
            // 同一时间的多个 401 只应产生一次续期：后到的直接复用前一个的结果
            McpTokenStore.StoredToken current = tokenStore.find(serverName).orElse(null);
            if (current == null) {
                return false;
            }
            if (!current.isExpiring(REFRESH_SKEW_MILLIS)) {
                return true;
            }
            Optional<OAuthMetadataClient.TokenResponse> refreshed = metadataClient
                    .refresh(current.tokenEndpoint(), current.clientId(), current.refreshToken(), current.resource());
            if (refreshed.isEmpty()) {
                log.warn("MCP 令牌续期失败，需要重新授权: name={}", serverName);
                tokenStore.remove(serverName);
                statuses.put(serverName, STATUS_FAILED);
                return false;
            }
            tokenStore.save(serverName, toStoredToken(refreshed.get(),
                    keepRefreshToken(refreshed.get(), current), current.clientId(), current.tokenEndpoint(),
                    current.resource()));
            statuses.put(serverName, STATUS_AUTHORIZED);
            log.info("MCP 令牌续期成功: name={}", serverName);
            return true;
        }
    }

    /** 回调到达后换令牌，全部在虚拟线程里做，调用方（HTTP 请求）不必等 */
    private void awaitAuthorization(String serverName, PendingAuthorization authorization) {
        try {
            String code = authorization.loopback().awaitAuthorizationCode(CALLBACK_TIMEOUT);
            if (code == null) {
                statuses.put(serverName, STATUS_FAILED);
                return;
            }
            Optional<OAuthMetadataClient.TokenResponse> exchanged = metadataClient.exchangeCode(
                    authorization.server(), authorization.clientId(), code, authorization.codeVerifier(),
                    authorization.loopback().redirectUri(), authorization.resource());
            if (exchanged.isEmpty()) {
                statuses.put(serverName, STATUS_FAILED);
                return;
            }
            McpTokenStore.StoredToken previous = tokenStore.find(serverName).orElse(null);
            tokenStore.save(serverName, toStoredToken(exchanged.get(),
                    keepRefreshToken(exchanged.get(), previous), authorization.clientId(),
                    authorization.server().tokenEndpoint(), authorization.resource()));
            statuses.put(serverName, STATUS_AUTHORIZED);
            log.info("MCP 授权回调完成: name={}", serverName);
        } catch (RuntimeException failure) {
            log.warn("MCP 授权流程失败: name={}", serverName, failure);
            statuses.put(serverName, STATUS_FAILED);
        } finally {
            pending.remove(serverName);
            authorization.loopback().close();
        }
    }

    private String resolveClientId(String serverName, OAuthMetadataClient.ServerMetadata server, String redirectUri) {
        String known = tokenStore.find(serverName).map(McpTokenStore.StoredToken::clientId)
                .filter(clientId -> !clientId.isBlank()).orElse(null);
        if (known != null) {
            return known;
        }
        return metadataClient.registerClient(server, redirectUri).orElseThrow(() -> new ClientException(
                "该授权服务器不支持免密注册客户端，请填写 OAuth 客户端标识"));
    }

    private McpTokenStore.StoredToken toStoredToken(OAuthMetadataClient.TokenResponse response, String refreshToken,
                                                   String clientId, String tokenEndpoint, String resource) {
        return new McpTokenStore.StoredToken(response.accessToken(), refreshToken, expiresAt(response),
                response.scope(), clientId, tokenEndpoint, resource);
    }

    /** 续期不换刷新令牌时沿用它：有的授权服务器只在新令牌里回一次 refresh_token */
    private static String keepRefreshToken(OAuthMetadataClient.TokenResponse response, McpTokenStore.StoredToken previous) {
        return response.refreshToken() != null ? response.refreshToken()
                : previous == null ? null : previous.refreshToken();
    }

    /** {@code expires_in} 缺失时按 1 小时保守假设：宁可提前刷新，也不要拿一个可能立刻过期的令牌去请求 */
    private static long expiresAt(OAuthMetadataClient.TokenResponse response) {
        long lifetimeMillis = response.expiresInSeconds() > 0
                ? Duration.ofSeconds(response.expiresInSeconds()).toMillis()
                : Duration.ofHours(1).toMillis();
        return System.currentTimeMillis() + lifetimeMillis;
    }

    private String buildAuthorizationUrl(OAuthMetadataClient.ServerMetadata server, String clientId, String redirectUri,
                                         String state, String challenge, List<String> scopes, String resource) {
        Map<String, String> parameters = new LinkedHashMap<>();
        parameters.put("response_type", "code");
        parameters.put("client_id", clientId);
        parameters.put("redirect_uri", redirectUri);
        parameters.put("state", state);
        parameters.put("code_challenge", challenge);
        parameters.put("code_challenge_method", "S256");
        if (!scopes.isEmpty()) {
            parameters.put("scope", String.join(" ", scopes));
        }
        // resource 决定令牌的受众；缺了它多租户授权服务器会签出对当前 MCP 端点无效的令牌
        parameters.put("resource", resource);

        StringBuilder url = new StringBuilder(server.authorizationEndpoint());
        url.append(server.authorizationEndpoint().contains("?") ? '&' : '?');
        boolean first = true;
        for (Map.Entry<String, String> parameter : parameters.entrySet()) {
            if (!first) {
                url.append('&');
            }
            url.append(URLEncoder.encode(parameter.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(parameter.getValue(), StandardCharsets.UTF_8));
            first = false;
        }
        return url.toString();
    }

    /** RFC 7636 S256：challenge = BASE64URL(SHA256(verifier))，不带 padding */
    private static String codeChallenge(String verifier) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException unsupported) {
            throw new IllegalStateException("JVM 缺少 SHA-256 实现", unsupported);
        }
    }

    private static String randomSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        new SecureRandom().nextBytes(secret);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    }

    /** 从 {@code Bearer resource_metadata="https://..."} 里取地址，取不到就返回 null */
    private static String parseResourceMetadata(String wwwAuthenticate) {
        int index = wwwAuthenticate.toLowerCase().indexOf("resource_metadata");
        if (index < 0) {
            return null;
        }
        int start = wwwAuthenticate.indexOf('"', index);
        int end = start < 0 ? -1 : wwwAuthenticate.indexOf('"', start + 1);
        return start < 0 || end < 0 ? null : wwwAuthenticate.substring(start + 1, end);
    }

    private void closePending(String serverName) {
        PendingAuthorization previous = pending.remove(serverName);
        if (previous != null) {
            previous.loopback().close();
        }
    }

    private Object lock(String serverName) {
        return locks.computeIfAbsent(serverName, ignored -> new Object());
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}

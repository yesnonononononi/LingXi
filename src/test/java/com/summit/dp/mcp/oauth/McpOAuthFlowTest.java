package com.summit.dp.mcp.oauth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.McpAuthMode;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.McpTransport;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.dp.mcp.domain.model.McpAuth;
import com.summit.dp.mcp.infrastructure.oauth.McpOAuthEngine;
import com.summit.dp.mcp.infrastructure.oauth.McpTokenStore;
import com.summit.dp.mcp.infrastructure.oauth.OAuthMcpAuthorizationProvider;
import com.summit.dp.mcp.infrastructure.oauth.OAuthMetadataClient;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.TestTimeouts;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import mcp.McpClientSettings;
import mcp.McpSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 授权流程的端到端验证：发现 → 注册 → PKCE → 回调 → 换令牌 → 用新凭据真正连上服务。
 *
 * <p>用真实 HTTP 而不是桩，是因为这条链路的价值全在「地址与参数拼得对不对」上：
 * 回调端口、state、resource、表单编码任何一处写错，桩都看不出来。</p>
 */
@Timeout(TestTimeouts.HANG_GUARD)
class McpOAuthFlowTest {

    private static final String SERVER_NAME = "oauth-server";
    private static final String AUTHORIZATION_CODE = "the-code";
    private static final String ACCESS_TOKEN = "access-token";
    private static final String REFRESHED_TOKEN = "access-token-refreshed";

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    @TempDir
    Path tempDir;

    private FakeAuthorizationServer fixture;
    private McpTokenStore tokenStore;
    private McpOAuthEngine engine;
    private McpSessionFactory sessionFactory;

    @BeforeEach
    void startFixture() throws IOException {
        fixture = new FakeAuthorizationServer(json);
        tokenStore = new McpTokenStore(json, tempDir.resolve("mcp-auth.json").toString());
        engine = new McpOAuthEngine(new OAuthMetadataClient(json), tokenStore);
    }

    @AfterEach
    void stopFixture() {
        if (sessionFactory != null) {
            sessionFactory.close();
        }
        fixture.close();
    }

    @Test
    void authorizationCompletesAndTheRebuiltConnectionIsAuthenticated() throws Exception {
        String authorizationUrl = engine.beginAuthorization(SERVER_NAME, fixture.mcpUrl(),
                new McpAuth(McpAuth.MODE_OAUTH, null, List.of(), null));

        assertTrue(authorizationUrl.contains("code_challenge_method=S256"),
                "授权请求必须带 PKCE: " + authorizationUrl);
        assertTrue(authorizationUrl.contains("resource="), "缺少 resource 会签出受众错误的令牌: " + authorizationUrl);

        completeInBrowser(authorizationUrl);

        assertEquals(McpOAuthEngine.STATUS_AUTHORIZED, awaitStatus(McpOAuthEngine.STATUS_AUTHORIZED));
        McpTokenStore.StoredToken stored = tokenStore.find(SERVER_NAME).orElseThrow();
        assertEquals(ACCESS_TOKEN, stored.accessToken());
        assertEquals("refresh-token", stored.refreshToken());
        assertEquals(FakeAuthorizationServer.CLIENT_ID, stored.clientId());

        // 授权后必须重建连接才能用上新凭据：SDK 的重放复用的是旧请求
        assertTrue(openServer().serverToolNames().contains("oauth_tool"));
        assertTrue(fixture.authorizations().contains("Bearer " + ACCESS_TOKEN),
                "连接必须带授权得到的令牌, got " + fixture.authorizations());
    }

    @Test
    void callbackWithMismatchedStateIsRejected() throws Exception {
        String authorizationUrl = engine.beginAuthorization(SERVER_NAME, fixture.mcpUrl(),
                new McpAuth(McpAuth.MODE_OAUTH, null, List.of(), null));
        Map<String, String> parameters = queryParameters(authorizationUrl);

        HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(parameters.get("redirect_uri")
                        + "?code=" + AUTHORIZATION_CODE + "&state=forged-state")).GET().build(),
                HttpResponse.BodyHandlers.ofString());

        assertEquals(400, response.statusCode());
        // 伪造的回调不能被当成授权成功：令牌文件都不该出现
        assertTrue(tokenStore.find(SERVER_NAME).isEmpty());
        assertFalse(McpOAuthEngine.STATUS_AUTHORIZED.equals(engine.resolveStatus(SERVER_NAME)));
    }

    @Test
    void unregisteredServerWithoutDiscoveryFailsWithGuidance() {
        ClientException failure = assertThrows(ClientException.class,
                () -> engine.beginAuthorization(SERVER_NAME, "http://127.0.0.1:1/mcp",
                        new McpAuth(McpAuth.MODE_OAUTH, null, List.of(), null)));

        assertTrue(failure.getMessage().contains("无法从该服务发现授权服务器"), failure.getMessage());
    }

    @Test
    void expiringTokenIsRenewedByRefresh() {
        tokenStore.save(SERVER_NAME, new McpTokenStore.StoredToken("stale", "refresh-token",
                System.currentTimeMillis() - 1_000L, "mcp:read", FakeAuthorizationServer.CLIENT_ID,
                fixture.origin() + "/token", fixture.mcpUrl()));

        assertTrue(engine.refresh(SERVER_NAME));
        assertEquals(REFRESHED_TOKEN, tokenStore.find(SERVER_NAME).orElseThrow().accessToken());
        assertTrue(fixture.grantTypes().contains("refresh_token"), "必须走刷新授权: " + fixture.grantTypes());
    }

    @Test
    void revokedRefreshTokenDropsTheStoredCredential() {
        tokenStore.save(SERVER_NAME, new McpTokenStore.StoredToken("stale", "refresh-token",
                System.currentTimeMillis() - 1_000L, "mcp:read", FakeAuthorizationServer.CLIENT_ID,
                fixture.origin() + "/token-missing", fixture.mcpUrl()));

        assertFalse(engine.refresh(SERVER_NAME));
        assertTrue(tokenStore.find(SERVER_NAME).isEmpty(), "刷新失败必须清掉坏令牌，否则每次连接都重跑 401");
    }

    private McpSession openServer() {
        sessionFactory = new McpSessionFactory(McpClientSettings.defaults(),
                List.of(new mcp.transport.McpHttpTransportBuilder(json,
                        new OAuthMcpAuthorizationProvider(engine))), null, json);
        return sessionFactory.openSession(server(), null, McpSessionType.PER_REQUEST, "");
    }

    private McpConfig.MCP server() {
        return new McpConfig.MCP(SERVER_NAME, null, McpTransport.STREAMABLE_HTTP,
                new McpConfig.StreamableHttp(fixture.mcpUrl(), Map.of(), Duration.ofSeconds(5), Duration.ofSeconds(5)),
                4_000, McpAuthMode.OAUTH);
    }

    /** 模拟用户在浏览器里同意授权：授权服务器把浏览器带回 loopback 回调 */
    private void completeInBrowser(String authorizationUrl) throws Exception {
        Map<String, String> parameters = queryParameters(authorizationUrl);
        String callback = parameters.get("redirect_uri") + "?code=" + AUTHORIZATION_CODE
                + "&state=" + parameters.get("state");
        HttpResponse<String> response = http.send(HttpRequest.newBuilder(URI.create(callback)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
    }

    private String awaitStatus(String expected) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 10_000L;
        String status = null;
        while (System.currentTimeMillis() < deadline) {
            status = engine.resolveStatus(SERVER_NAME);
            if (expected.equals(status)) {
                return status;
            }
            Thread.sleep(50L);
        }
        return status;
    }

    private static Map<String, String> queryParameters(String url) {
        Map<String, String> parameters = new LinkedHashMap<>();
        String query = URI.create(url).getRawQuery();
        assertNotNull(query, "授权地址没有查询参数: " + url);
        for (String pair : query.split("&")) {
            int separator = pair.indexOf('=');
            parameters.put(URLDecoder.decode(pair.substring(0, separator), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(separator + 1), StandardCharsets.UTF_8));
        }
        return parameters;
    }

    /** 一个最小的授权服务器 + 受保护的 MCP 端点，全部走真实 HTTP */
    private static final class FakeAuthorizationServer implements AutoCloseable {

        static final String CLIENT_ID = "client-from-registration";

        private final ObjectMapper json;
        private final HttpServer server;
        private final List<String> authorizations = new CopyOnWriteArrayList<>();
        private final List<String> grantTypes = new CopyOnWriteArrayList<>();

        FakeAuthorizationServer(ObjectMapper json) throws IOException {
            this.json = json;
            this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::handle);
            server.start();
        }

        String origin() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        String mcpUrl() {
            return origin() + "/mcp";
        }

        List<String> authorizations() {
            return authorizations;
        }

        List<String> grantTypes() {
            return grantTypes;
        }

        @Override
        public void close() {
            server.stop(0);
        }

        private void handle(HttpExchange exchange) throws IOException {
            try (exchange) {
                String path = exchange.getRequestURI().getPath();
                switch (path) {
                    case "/mcp" -> handleMcp(exchange);
                    case "/.well-known/oauth-protected-resource" -> respond(exchange, 200,
                            Map.of("resource", mcpUrl(), "authorization_servers", List.of(origin()),
                                    "scopes_supported", List.of("mcp:read")));
                    case "/.well-known/oauth-authorization-server" -> respond(exchange, 200, Map.of(
                            "issuer", origin(),
                            "authorization_endpoint", origin() + "/authorize",
                            "token_endpoint", origin() + "/token",
                            "registration_endpoint", origin() + "/register",
                            "scopes_supported", List.of("mcp:read")));
                    case "/register" -> respond(exchange, 200, Map.of("client_id", CLIENT_ID));
                    case "/token" -> handleToken(exchange);
                    default -> exchange.sendResponseHeaders(404, -1);
                }
            }
        }

        private void handleMcp(HttpExchange exchange) throws IOException {
            if (!"POST".equals(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            if (authorization != null) {
                authorizations.add(authorization);
            }
            if (!("Bearer " + ACCESS_TOKEN).equals(authorization)
                    && !("Bearer " + REFRESHED_TOKEN).equals(authorization)) {
                exchange.getResponseHeaders().set("WWW-Authenticate",
                        "Bearer resource_metadata=\"" + origin() + "/.well-known/oauth-protected-resource\"");
                exchange.sendResponseHeaders(401, -1);
                return;
            }
            JsonNode request = json.readTree(exchange.getRequestBody());
            if (!request.has("id")) {
                exchange.sendResponseHeaders(202, -1);
                return;
            }
            Object result = "initialize".equals(request.path("method").asText(""))
                    ? Map.of("protocolVersion", request.path("params").path("protocolVersion").asText("2025-11-25"),
                    "capabilities", Map.of("tools", Map.of()),
                    "serverInfo", Map.of("name", "oauth-fixture", "version", "1.0"))
                    : Map.of("tools", List.of(Map.of("name", "oauth_tool", "description", "授权后才能用",
                    "inputSchema", Map.of("type", "object", "properties", Map.of()))));
            respond(exchange, 200, Map.of("jsonrpc", "2.0", "id", request.get("id"), "result", result));
        }

        private void handleToken(HttpExchange exchange) throws IOException {
            Map<String, String> form = parseForm(new String(exchange.getRequestBody().readAllBytes(),
                    StandardCharsets.UTF_8));
            String grantType = form.getOrDefault("grant_type", "");
            grantTypes.add(grantType);
            if ("authorization_code".equals(grantType)) {
                if (!AUTHORIZATION_CODE.equals(form.get("code")) || form.get("code_verifier") == null) {
                    respond(exchange, 400, Map.of("error", "invalid_grant"));
                    return;
                }
                respond(exchange, 200, Map.of("access_token", ACCESS_TOKEN, "refresh_token", "refresh-token",
                        "expires_in", 3600, "scope", "mcp:read"));
                return;
            }
            if ("refresh_token".equals(grantType)) {
                respond(exchange, 200, Map.of("access_token", REFRESHED_TOKEN, "expires_in", 3600));
                return;
            }
            respond(exchange, 400, Map.of("error", "unsupported_grant_type"));
        }

        private void respond(HttpExchange exchange, int status, Map<String, ?> body) throws IOException {
            byte[] bytes = json.writeValueAsBytes(body);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
        }

        private static Map<String, String> parseForm(String body) {
            Map<String, String> form = new HashMap<>();
            for (String pair : body.split("&")) {
                int separator = pair.indexOf('=');
                if (separator <= 0) {
                    continue;
                }
                form.put(URLDecoder.decode(pair.substring(0, separator), StandardCharsets.UTF_8),
                        URLDecoder.decode(pair.substring(separator + 1), StandardCharsets.UTF_8));
            }
            return form;
        }
    }
}

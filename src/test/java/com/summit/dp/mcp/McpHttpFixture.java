package com.summit.dp.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;

/** 使用真实 HTTP 通道验证协议握手，不执行远端工具。 */
public final class McpHttpFixture implements AutoCloseable {

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpServer server;
    private final String expectedAuthorization;

    public McpHttpFixture(String expectedAuthorization) throws IOException {
        this.expectedAuthorization = expectedAuthorization;
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/mcp", this::handle);
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/mcp";
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"POST".equals(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }
            if (expectedAuthorization != null
                    && !expectedAuthorization.equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                exchange.sendResponseHeaders(401, -1);
                return;
            }
            JsonNode request = mapper.readTree(exchange.getRequestBody());
            if (!request.has("id")) {
                exchange.sendResponseHeaders(202, -1);
                return;
            }
            String method = request.path("method").asText();
            Object result = switch (method) {
                case "initialize" -> Map.of("protocolVersion", request.path("params").path("protocolVersion").asText(),
                        "capabilities", Map.of("tools", Map.of()),
                        "serverInfo", Map.of("name", "http-fixture", "version", "1.0"));
                case "tools/list" -> Map.of("tools", List.of(Map.of("name", "http_echo",
                        "description", "连接测试工具", "inputSchema", Map.of("type", "object", "properties", Map.of()))));
                case "ping" -> Map.of();
                default -> null;
            };
            Map<String, Object> response = result == null
                    ? Map.of("jsonrpc", "2.0", "id", request.get("id"),
                    "error", Map.of("code", -32601, "message", "Method not found"))
                    : Map.of("jsonrpc", "2.0", "id", request.get("id"), "result", result);
            byte[] bytes = mapper.writeValueAsBytes(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}

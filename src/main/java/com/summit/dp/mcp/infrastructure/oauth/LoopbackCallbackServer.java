package com.summit.dp.mcp.infrastructure.oauth;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 承接授权回调的本地服务器。
 *
 * <p>绑 {@code 127.0.0.1} 的随机端口而不是本进程的服务端口：端口冲突时授权会直接失败，
 * 且 RFC 8252 要求的正是 loopback 临时端口。每次待授权独占一个实例，收到一次回调即结束。</p>
 */
@Slf4j
public final class LoopbackCallbackServer implements AutoCloseable {

    private static final String CALLBACK_PATH = "/callback";

    private final HttpServer server;
    private final String expectedState;
    private final CompletableFuture<String> authorizationCode = new CompletableFuture<>();

    private LoopbackCallbackServer(HttpServer server, String expectedState) {
        this.server = server;
        this.expectedState = expectedState;
    }

    /**
     * 启动回调服务器。
     *
     * @param expectedState 授权请求里的 state，回调必须原样带回
     * @throws IllegalStateException 端口无法绑定
     */
    public static LoopbackCallbackServer start(String expectedState) {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            LoopbackCallbackServer callback = new LoopbackCallbackServer(server, expectedState);
            server.createContext(CALLBACK_PATH, callback::handle);
            server.start();
            return callback;
        } catch (IOException failure) {
            throw new IllegalStateException("无法启动授权回调端口", failure);
        }
    }

    /** @return 授权服务器要回跳到的地址，形如 {@code http://127.0.0.1:52341/callback} */
    public String redirectUri() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + CALLBACK_PATH;
    }

    /**
     * 等待授权码。
     *
     * @return 授权码；用户拒绝授权或超时时为 null
     */
    public String awaitAuthorizationCode(Duration timeout) {
        try {
            return authorizationCode.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timedOut) {
            log.warn("MCP 授权回调超时: timeoutMillis={}", timeout.toMillis());
            return null;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException failure) {
            log.warn("MCP 授权回调失败", failure.getCause());
            return null;
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String rawQuery = exchange.getRequestURI().getRawQuery();
            // state 必须全等：它是这条回调属于哪次授权请求的唯一凭据，错配就当成攻击
            if (!expectedState.equals(queryValue(rawQuery, "state"))) {
                respond(exchange, 400, "授权状态校验失败，请回到应用重新发起授权");
                return;
            }
            String error = queryValue(rawQuery, "error");
            if (error != null) {
                respond(exchange, 200, "授权未完成：" + error + "，可以关闭此窗口");
                authorizationCode.completeExceptionally(new IllegalStateException("授权被拒绝: " + error));
                return;
            }
            String code = queryValue(rawQuery, "code");
            if (code == null || code.isBlank()) {
                respond(exchange, 400, "回调缺少授权码");
                authorizationCode.completeExceptionally(new IllegalStateException("回调缺少授权码"));
                return;
            }
            respond(exchange, 200, "授权完成，可以关闭此窗口并返回应用");
            authorizationCode.complete(code);
        }
    }

    private static void respond(HttpExchange exchange, int status, String message) throws IOException {
        byte[] body = ("<!doctype html><meta charset=\"utf-8\"><p>" + message + "</p>")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    /** 取查询参数；键值都按 UTF-8 解码，授权码里的保留字符由表单编码携带 */
    private static String queryValue(String rawQuery, String key) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return null;
        }
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            if (separator <= 0) {
                continue;
            }
            if (key.equals(URLDecoder.decode(pair.substring(0, separator), StandardCharsets.UTF_8))) {
                return URLDecoder.decode(pair.substring(separator + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }
}

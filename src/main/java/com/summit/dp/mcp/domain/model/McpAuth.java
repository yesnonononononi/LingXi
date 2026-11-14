package com.summit.dp.mcp.domain.model;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * 服务的认证方式。
 *
 * <p>{@code mode=none} 表示凭据只来自配置的请求头（历史行为）；{@code mode=oauth} 表示凭据由授权
 * 流程在运行时取得。其余字段只在 oauth 下使用，且都可留空：能从服务端发现就不该让用户手填。</p>
 *
 * <p>不提供「从 headers 推断模式」的入口：静态请求头与运行时凭据是两种独立意图，猜错会直接把
 * 一个能用的服务改成需要登录。</p>
 */
public record McpAuth(String mode, String clientId, List<String> scopes, String authorizationServer) {

    public static final String MODE_NONE = "none";
    public static final String MODE_OAUTH = "oauth";

    /** 未配置认证：与 auth 字段出现之前的行为完全一致 */
    public static final McpAuth NONE = new McpAuth(MODE_NONE, null, List.of(), null);

    public static final int CLIENT_ID_MAX_LENGTH = 256;
    public static final int SCOPE_MAX_ITEMS = 16;
    public static final int SCOPE_MAX_LENGTH = 128;

    public McpAuth {
        mode = resolveMode(mode);
        clientId = trimToNull(clientId);
        authorizationServer = trimToNull(authorizationServer);
        scopes = resolveScopes(scopes);

        if (clientId != null) {
            if (clientId.length() > CLIENT_ID_MAX_LENGTH) {
                throw new IllegalArgumentException("OAuth 客户端标识长度不能超过" + CLIENT_ID_MAX_LENGTH);
            }
            if (clientId.chars().anyMatch(Character::isWhitespace)) {
                throw new IllegalArgumentException("OAuth 客户端标识不能包含空白");
            }
        }
        if (authorizationServer != null && !isHttpUrl(authorizationServer)) {
            throw new IllegalArgumentException("授权服务器地址必须是 http 或 https 开头的合法地址");
        }
    }

    /** @return 是否走运行时授权流程 */
    public boolean isOauth() {
        return MODE_OAUTH.equals(mode);
    }

    /** 空值（含历史数据缺失）一律落到 none，避免旧配置凭空变成需要登录 */
    private static String resolveMode(String mode) {
        if (mode == null || mode.isBlank()) {
            return MODE_NONE;
        }
        String normalized = mode.trim().toLowerCase(Locale.ROOT);
        if (!MODE_NONE.equals(normalized) && !MODE_OAUTH.equals(normalized)) {
            throw new IllegalArgumentException("认证方式仅支持 none / oauth");
        }
        return normalized;
    }

    /** 去空白、去重、保序；超出条数或单条长度直接拒绝，而不是悄悄截断 */
    private static List<String> resolveScopes(List<String> scopes) {
        if (scopes == null || scopes.isEmpty()) {
            return List.of();
        }
        LinkedHashSet<String> resolved = new LinkedHashSet<>();
        for (String scope : scopes) {
            String trimmed = trimToNull(scope);
            if (trimmed == null) {
                continue;
            }
            if (trimmed.length() > SCOPE_MAX_LENGTH) {
                throw new IllegalArgumentException("OAuth 授权范围单条长度不能超过" + SCOPE_MAX_LENGTH);
            }
            resolved.add(trimmed);
        }
        if (resolved.size() > SCOPE_MAX_ITEMS) {
            throw new IllegalArgumentException("OAuth 授权范围不能超过" + SCOPE_MAX_ITEMS + "条");
        }
        return List.copyOf(new ArrayList<>(resolved));
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static boolean isHttpUrl(String url) {
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme();
            return uri.getHost() != null
                    && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }
}

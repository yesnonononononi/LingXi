package com.summit.dp.mcp.infrastructure.oauth;

import com.summit.core.conf.McpAuthMode;
import com.summit.core.conf.McpConfig;
import lombok.RequiredArgsConstructor;
import mcp.McpAuthorizationProvider;
import mcp.McpServerAuthorization;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

/**
 * 把 OAuth 凭据接进框架的 MCP 传输。
 *
 * <p>{@code lingxi.mcp.oauth.enabled=false} 时本类不发布，所有服务退回「只用静态请求头」的老行为——
 * 这是出问题时不必回滚代码的闸门。</p>
 */
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "lingxi.mcp.oauth.enabled", havingValue = "true", matchIfMissing = true)
public class OAuthMcpAuthorizationProvider implements McpAuthorizationProvider {

    private final McpOAuthEngine engine;

    /** 只接管声明了 oauth 的服务；返回 null 让静态请求头那条老路径保持原样 */
    @Override
    public McpServerAuthorization resolveAuthorization(McpConfig.MCP server) {
        if (server.resolveAuthMode() != McpAuthMode.OAUTH) {
            return null;
        }
        return new EngineBackedAuthorization(server.name(), engine);
    }

    /** 按服务名绑定引擎：令牌的读写都以服务名为键 */
    private record EngineBackedAuthorization(String serverName, McpOAuthEngine engine)
            implements McpServerAuthorization {

        /** 只用 setHeader：改成追加会让请求同时带上配置里的旧凭据与服务端刚签发的令牌 */
        @Override
        public void customize(HttpRequest.Builder requestBuilder) {
            String accessToken = engine.resolveAccessToken(serverName);
            if (accessToken != null) {
                requestBuilder.setHeader("Authorization", "Bearer " + accessToken);
            }
        }

        /**
         * 先记下服务端指明的资源元数据地址，再试一次静默续期。
         *
         * <p>续期拿到的令牌给的是下一次连接：框架重放的是已经构建好的那个请求，新令牌到不了它手里。
         * 续期失败会把状态打回「需要授权」，由用户决定是否重新授权。</p>
         */
        @Override
        public void onAuthorizationError(HttpResponse.ResponseInfo response) {
            engine.noteChallenge(serverName, response.headers().firstValue("WWW-Authenticate").orElse(null));
            engine.refresh(serverName);
        }
    }
}

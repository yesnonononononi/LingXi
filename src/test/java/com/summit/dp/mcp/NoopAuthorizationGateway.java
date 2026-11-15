package com.summit.dp.mcp;

import com.summit.dp.mcp.application.service.McpAuthorizationGateway;
import com.summit.dp.mcp.domain.model.McpAuth;
import com.summit.dp.shared.exception.ClientException;

/**
 * 测试用的授权网关：从不发起授权，也永远没有可用令牌。
 *
 * <p>连接相关用例关心的是「拿不到凭据之后会发生什么」，不需要一个真授权服务器；
 * 需要真流程的用例在 {@code oauth} 包里自己搭。</p>
 */
final class NoopAuthorizationGateway implements McpAuthorizationGateway {

    static final NoopAuthorizationGateway INSTANCE = new NoopAuthorizationGateway();

    private NoopAuthorizationGateway() {
    }

    @Override
    public String beginAuthorization(String serverName, String mcpUrl, McpAuth auth) {
        throw new ClientException("测试环境不发起授权");
    }

    @Override
    public String resolveStatus(String serverName) {
        return null;
    }

    @Override
    public String resolveAuthorizationUrl(String serverName) {
        return null;
    }

    @Override
    public boolean hasUsableToken(String serverName) {
        return false;
    }

    @Override
    public boolean hasCredential(String serverName) {
        return false;
    }
}

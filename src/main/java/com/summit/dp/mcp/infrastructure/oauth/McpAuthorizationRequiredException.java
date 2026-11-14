package com.summit.dp.mcp.infrastructure.oauth;

import com.summit.dp.shared.exception.ClientException;

/**
 * 服务连得上但被拒绝：必须先完成授权，重复连接不会自愈。
 *
 * <p>与普通连接失败分开是有代价的：混在一起时用户看到「请检查地址、命令、凭据和超时」，
 * 这句话会把人引到网络排查上，而真正该做的是点一下授权。</p>
 */
public class McpAuthorizationRequiredException extends ClientException {

    private final String serverName;
    private final String authorizationUrl;

    public McpAuthorizationRequiredException(String serverName, String authorizationUrl, Throwable cause) {
        super("MCP 服务「" + serverName + "」需要登录授权，请点击「去授权」完成登录", cause);
        this.serverName = serverName;
        this.authorizationUrl = authorizationUrl;
    }

    public String getServerName() {
        return serverName;
    }

    /** @return 已在途的授权地址；还没发起授权时为 null */
    public String getAuthorizationUrl() {
        return authorizationUrl;
    }
}

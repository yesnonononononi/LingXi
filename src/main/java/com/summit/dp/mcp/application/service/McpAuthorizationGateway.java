package com.summit.dp.mcp.application.service;

import com.summit.dp.mcp.domain.model.McpAuth;

/**
 * 运行时授权能力的契约面：应用层与连接管理都只依赖它，不依赖具体的 OAuth 实现。
 *
 * <p>与 {@link McpConnectionRegistry} 同一套分工：接口住应用层，实现住基础设施层。</p>
 */
public interface McpAuthorizationGateway {

    /**
     * 发起授权。
     *
     * @param serverName 服务名，令牌按它保存
     * @param mcpUrl     服务地址，同时作为授权请求的 resource
     * @param auth       配置的认证方式
     * @return 需要在浏览器里打开的授权地址
     */
    String beginAuthorization(String serverName, String mcpUrl, McpAuth auth);

    /** @return 授权状态 PENDING / AUTHORIZED / FAILED；从未授权过为 null */
    String resolveStatus(String serverName);

    /** @return 在途授权的地址；没有在途授权为 null */
    String resolveAuthorizationUrl(String serverName);

    /** @return 当前是否有可用（未过期）的访问令牌 */
    boolean hasUsableToken(String serverName);
}

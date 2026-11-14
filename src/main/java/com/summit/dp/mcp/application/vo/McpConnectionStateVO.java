package com.summit.dp.mcp.application.vo;

/**
 * 共享连接的运行状态，供设置页展示。
 * <p>state 取值：CONNECTED / FAILED / DISCONNECTED / DISABLED / AUTHORIZATION_REQUIRED；
 * error 只在 FAILED 与 AUTHORIZATION_REQUIRED 时有值，不含凭据。</p>
 * <p>authorizationUrl 只在 AUTHORIZATION_REQUIRED 且有在途授权时非空：前端拿它开浏览器，
 * 没有就要先调授权接口拿地址。</p>
 */
public record McpConnectionStateVO(Long id, String state, Integer toolCount, String error, String authorizationUrl) {

    public static final String CONNECTED = "CONNECTED";
    public static final String FAILED = "FAILED";
    public static final String DISCONNECTED = "DISCONNECTED";
    public static final String DISABLED = "DISABLED";
    /** 连上了但被拒绝：需要用户完成授权，重试不会自愈 */
    public static final String AUTHORIZATION_REQUIRED = "AUTHORIZATION_REQUIRED";

    /** 不需要授权地址的四个状态用它构造，省掉到处写 null */
    public McpConnectionStateVO(Long id, String state, Integer toolCount, String error) {
        this(id, state, toolCount, error, null);
    }
}

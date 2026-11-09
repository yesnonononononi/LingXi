package com.summit.dp.mcp.application.vo;

/**
 * 共享连接的运行状态，供设置页展示。
 * <p>state 取值：CONNECTED / FAILED / DISCONNECTED / DISABLED；error 只在 FAILED 时有值，不含凭据。</p>
 */
public record McpConnectionStateVO(Long id, String state, Integer toolCount, String error) {

    public static final String CONNECTED = "CONNECTED";
    public static final String FAILED = "FAILED";
    public static final String DISCONNECTED = "DISCONNECTED";
    public static final String DISABLED = "DISABLED";
}

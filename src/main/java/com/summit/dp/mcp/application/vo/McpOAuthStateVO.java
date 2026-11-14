package com.summit.dp.mcp.application.vo;

/**
 * 授权进度，供设置页轮询。
 *
 * @param state PENDING / AUTHORIZED / FAILED；从未发起过授权时为 null
 * @param errMsg 授权失败时给用户看的原因，其余情况为 null
 */
public record McpOAuthStateVO(String state, String errMsg) {

    public static final McpOAuthStateVO UNKNOWN = new McpOAuthStateVO(null, null);
}

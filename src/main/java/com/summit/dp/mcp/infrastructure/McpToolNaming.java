package com.summit.dp.mcp.infrastructure;

/** 两种连接生命周期保持同一工具名，避免切换工作区后工具标识变化。 */
final class McpToolNaming {
    private McpToolNaming() { }
    static String buildPrefix(String serverName) {
        String sanitized = serverName == null ? "" : serverName.replaceAll("[^A-Za-z0-9_-]", "_");
        return sanitized.isEmpty() ? "mcp_" : "mcp_" + sanitized + "_";
    }
}

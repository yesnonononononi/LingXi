package com.summit.dp.mcp.application.service;

import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;

/** 工作流仅借用已配置的会话，不直接依赖连接池实现。 */
public interface McpSessionRegistry {
    McpToolScope openScope(McpConfig config);
}

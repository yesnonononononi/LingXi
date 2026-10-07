package com.summit.dp.mcp.application.vo;

import java.util.List;

/** 连接测试结果只包含工具名称，避免返回配置凭据。 */
public record McpConnectionVO(int toolCount, List<String> toolNames, long elapsedMillis) {
}

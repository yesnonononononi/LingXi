package com.summit.dp.mcp.application.service;

import com.summit.core.conf.McpConfig;
import com.summit.dp.mcp.application.vo.McpConnectionVO;

/** 配置落库后同步进程连接池，连接失败不撤销已保存的配置。 */
public interface McpConnectionRegistry {

    /** 测试未保存的配置，临时连接不进入进程连接池。 */
    McpConnectionVO connect(McpConfig.MCP server);

    void register(Long id);

    void remove(Long id);
}

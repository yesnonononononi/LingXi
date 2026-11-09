package com.summit.dp.mcp.application.service;

import com.summit.core.conf.McpConfig;
import com.summit.dp.mcp.application.vo.McpConnectionStateVO;
import com.summit.dp.mcp.application.vo.McpConnectionVO;

/** 配置落库后同步进程连接池，连接失败不撤销已保存的配置。 */
public interface McpConnectionRegistry {

    /** 测试未保存的配置，临时连接不进入进程连接池。 */
    McpConnectionVO connect(McpConfig.MCP server);

    void register(Long id);

    void remove(Long id);

    /** 无论配置是否变化都关闭旧连接并重建；失败原因会记入状态。 */
    void reconnect(Long id);

    /** 只看进程内连接表，不判断启停，启停由调用方按库中配置决定。 */
    McpConnectionStateVO resolveState(Long id);
}

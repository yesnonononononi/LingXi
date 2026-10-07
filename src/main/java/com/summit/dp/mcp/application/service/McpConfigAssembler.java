package com.summit.dp.mcp.application.service;

import com.summit.core.conf.McpConfig;
import com.summit.core.conf.McpTransport;
import com.summit.dp.mcp.domain.model.Mcp;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 请求快照与连接池使用同一份配置映射，避免凭据和超时不一致。 */
@Component
public class McpConfigAssembler {

    public McpConfig.MCP toServer(Mcp model) {
        McpTransport transport = McpTransport.parse(model.getTransport().toString());
        McpConfig.Conf conf = switch (transport) {
            case STREAMABLE_HTTP, SSE -> new McpConfig.StreamableHttp(
                    model.getUrl(), model.getHeaders() == null ? Map.of() : model.getHeaders(),
                    model.getInitializationTimeout(), model.getExecutionTimeout());
            case STDIO -> new McpConfig.Stdio(
                    model.getCommand(), model.getEnv() == null ? Map.of() : model.getEnv(),
                    model.getInitializationTimeout(), model.getExecutionTimeout());
        };
        return new McpConfig.MCP(model.getName(), model.getDescription(), transport, conf, model.getMaxOutput());
    }
}

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
            // SSE 已无可用的客户端传输：映射成 StreamableHttp 只会让下游报出「transport 不匹配」这种
            // 看不出病因的错，所以在这里就用能指导用户动作的话拒绝。
            case SSE -> throw new IllegalArgumentException("SSE 传输不受支持，请改用 streamable-http");
            case STREAMABLE_HTTP -> new McpConfig.StreamableHttp(
                    model.getUrl(), model.getHeaders() == null ? Map.of() : model.getHeaders(),
                    model.getInitializationTimeout(), model.getExecutionTimeout(),
                    model.getProtocolVersion(), model.getAutoHealthCheck(),
                    model.getHealthCheckInterval(), model.getReconnectInterval());
            // 工作目录不在领域模型里，业务库没有该概念，保持 null（框架侧回落到子进程的父目录）
            case STDIO -> new McpConfig.Stdio(
                    model.getCommand(), model.getEnv() == null ? Map.of() : model.getEnv(), null,
                    model.getInitializationTimeout(), model.getExecutionTimeout(),
                    model.getProtocolVersion(), model.getAutoHealthCheck(),
                    model.getHealthCheckInterval(), model.getReconnectInterval());
        };
        return new McpConfig.MCP(model.getName(), model.getDescription(), transport, conf, model.getMaxOutput());
    }
}

package com.summit.dp.mcp.infrastructure;

import com.summit.adapter.langchain4j.mcp.Langchain4jMcpSession;
import com.summit.adapter.langchain4j.mcp.MCPToolConverter;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceStdioLauncher;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.mcp.client.McpClient;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import java.util.ArrayList;
import java.util.List;

/** 沙箱会话归请求所有，不能借用进程级连接池的宿主机权限。 */
@Slf4j
@RequiredArgsConstructor
final class IsolatedMcpScopeProvider {
    private final McpClientFactory clientFactory;

    void validate(McpConfig config, Workspace workspace) {
        if (config.getMcp() == null || config.getMcp().isEmpty()) return;
        for (McpConfig.MCP server : config.getMcp()) {
            throwIf(!(server.conf() instanceof McpConfig.Stdio), "沙箱模式仅支持 stdio MCP，不能连接远端服务：" + server.name());
        }
        throwIf(!(workspace.bridge() instanceof WorkspaceStdioLauncher), "当前沙箱不支持 MCP stdio 进程启动，请检查工作区适配器");
    }

    McpToolScope openScope(List<McpConfig.MCP> servers, Workspace workspace) {
        List<McpSession> sessions = new ArrayList<>();
        try {
            for (McpConfig.MCP server : servers) {
                McpClient client = null;
                try {
                    client = clientFactory.create(server.name(), server, workspace);
                    long timeout = (long) Math.ceil(server.executionTimeout().toMillis() / 1000.0) + 5L;
                    sessions.add(Langchain4jMcpSession.connect(server.name(), server.description(), client,
                            new MCPToolConverter(server.maxOutput(), timeout, McpToolNaming.buildPrefix(server.name()))));
                } catch (RuntimeException failure) {
                    if (client != null) {
                        try { client.close(); }
                        catch (Exception cleanup) { failure.addSuppressed(cleanup); }
                    }
                    log.warn("创建沙箱 MCP 会话失败: name={}, error={}", server.name(), failure.getClass().getSimpleName());
                }
            }
            return McpToolScope.of(sessions);
        } catch (RuntimeException | Error failure) {
            for (McpSession session : sessions) {
                try { session.close(); }
                catch (RuntimeException cleanup) { failure.addSuppressed(cleanup); }
            }
            throw failure;
        }
    }

    private void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }
}

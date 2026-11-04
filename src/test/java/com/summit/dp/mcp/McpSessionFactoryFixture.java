package com.summit.dp.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import mcp.McpClientSettings;
import mcp.McpSessionFactory;
import mcp.transport.McpHttpTransportBuilder;
import mcp.transport.McpStdioTransportBuilder;

import java.util.ArrayList;
import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 真连接测试用的工厂装配：与框架自动配置同一份参数，避免每个用例各配一套。
 *
 * <p>健康检查线程传 {@code null}：单测不需要后台探活，连接只在会话生命周期内活着，
 * 也就不会给测试进程留下常驻线程。</p>
 */
final class McpSessionFactoryFixture {

    private McpSessionFactoryFixture() {
    }

    /** @return 未开启后台健康检查的真实工厂；调用方负责 close() */
    static McpSessionFactory realFactory(ObjectMapper json) {
        return new McpSessionFactory(McpClientSettings.defaults(),
                List.of(new McpHttpTransportBuilder(json), new McpStdioTransportBuilder(json)), null, json);
    }

    /**
     * 一个「已连上、已发布带前缀工具」的假会话。
     *
     * @param serverName  配置里的服务名，前缀按 {@code mcp_<server>_} 拼出来（期望名显式写在测试里）
     * @param remoteTools 服务端自己声明的工具名，不带前缀
     */
    static McpSession mockSession(String serverName, String... remoteTools) {
        McpSession session = mock(McpSession.class);
        when(session.name()).thenReturn(serverName);
        when(session.description()).thenReturn(serverName);
        when(session.type()).thenReturn(McpSessionType.REUSE);
        when(session.tools()).thenReturn(prefixedTools(serverName, remoteTools));
        when(session.serverToolNames()).thenReturn(List.of(remoteTools));
        return session;
    }

    /** 与框架一致的工具名映射：模型看到的是 {@code mcp_<server>_<原名>}。 */
    static List<ToolDefinition<? extends ToolExecutor>> prefixedTools(String serverName, String... remoteTools) {
        String prefix = "mcp_" + serverName + "_";
        List<ToolDefinition<? extends ToolExecutor>> tools = new ArrayList<>();
        for (String remote : remoteTools) {
            ToolDefinition<ToolExecutor> definition = new ToolDefinition<>(1000, 6L, mock(ToolExecutor.class),
                    prefix + remote, prefix + remote, prefix + remote, "{\"type\":\"object\"}",
                    ConcurrentPolicy.READ_ONLY);
            tools.add(definition);
        }
        return tools;
    }
}

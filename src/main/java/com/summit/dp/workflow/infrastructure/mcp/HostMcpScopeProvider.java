package com.summit.dp.workflow.infrastructure.mcp;

import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.mcp.application.service.McpSessionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 第一版明确复用宿主连接；执行环境的接入决定只放在工作流边界。 */
@Component
@RequiredArgsConstructor
public final class HostMcpScopeProvider implements ScopeMcpProvider {
    private final McpSessionRegistry sessions;
    @Override public McpToolScope openScope(McpConfig config) { return sessions.openScope(config); }
    @Override public McpToolScope openScope(McpConfig config, Workspace workspace) {
        return sessions.openScope(config);
    }
}

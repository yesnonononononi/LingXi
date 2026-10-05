package com.summit.dp.mcp.infrastructure;

import com.summit.adapter.langchain4j.mcp.Langchain4jMcpSession;
import com.summit.adapter.langchain4j.mcp.MCPToolConverter;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.dp.mcp.application.service.McpService;
import jakarta.annotation.PostConstruct;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Slf4j
@Component
@RequiredArgsConstructor
public class McpManager implements ScopeMcpProvider {

    private final McpService mcpService;
    private final List<McpSession> mcpSessionList=  new ArrayList<>();
    private final McpClientFactory mcpClientFactory;
    private static final long RUNTIME_TIMEOUT_GRACE_SECONDS = 5L;

    @PostConstruct
    public void connect(){
        // step one : load  mcp configs of user
        McpConfig configs = mcpService.currentConfig();

        // step two : convert to the mcp session
        for (McpConfig.MCP mcp : configs.getMcp()) {
            long runtimeTimeout = (long) Math.ceil(mcp.executionTimeout().toMillis() / 1000.0) + RUNTIME_TIMEOUT_GRACE_SECONDS;
            Langchain4jMcpSession session = Langchain4jMcpSession.connect(
                    mcp.name(),
                    mcp.description(),
                    mcpClientFactory.create(mcp.name(), mcp),
                    new MCPToolConverter(mcp.maxOutput(), runtimeTimeout),
                    // The pool is shared across requests: without REUSE the first finished
                    // execution's scope closes every client and all later requests fail fast.
                    McpSessionType.REUSE
            );

            this.mcpSessionList.add(session);
            log.info("found mcp server {} ",  mcp.name());
        }
    }

    @Override
    public McpToolScope openScope(@NonNull McpConfig mcpConfig) {
        return McpToolScope.of(this.mcpSessionList);
    }
}

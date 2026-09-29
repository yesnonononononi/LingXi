package com.summit.dp.agent.infrastructure.agent;

import com.summit.core.conf.ModelConfig;
import com.summit.core.mcp.McpRegister;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.workspace.WorkspaceManager;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Primary;

import com.summit.runtime.agent.ChatAgent;
import com.summit.runtime.workspace.WorkspaceDestroyer;

@Component
@Primary
public class IChatAgent extends ChatAgent {

    /**
     * 必须使用 5 参构造器并注入 {@link McpRegister}。
     *
     * <p>4 参构造器会把 {@code mcpRegister} 置为 {@code null}，导致
     * {@code ChatAgent#openMcpScope} 恒走 {@code McpToolScope.EMPTY} 分支，
     * 请求级 MCP 工具全部无法注入且无任何日志提示。</p>
     */
    public IChatAgent(RuntimeFactory defaultRuntimeFactory,
                      RequestModelInvokerFactory modelInvokerFactory,
                      WorkspaceManager workspaceManager,
                      @Qualifier("chatModelConfig") ModelConfig modelConfig,
                      McpRegister mcpRegister) {
        super(defaultRuntimeFactory, modelInvokerFactory, workspaceManager, modelConfig, mcpRegister);
    }

    @Override
    public String id() {
        return "chatAgent";
    }
}

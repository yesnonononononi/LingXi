package com.summit.dp.agent.infrastructure.agent;


import com.summit.core.conf.ModelConfig;
import com.summit.core.mcp.McpRegister;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.runtime.agent.ChatAgent;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;


@Component
public class SubAgent extends ChatAgent {

    /**
     * RuntimeFactory 惰性注入：defaultRuntimeFactory 依赖工具注册表，而注册表里的委派工具又依赖 SubAgent，
     * 直接注入会构成循环依赖。惰性代理把解析推迟到真正执行子 Agent 时，此时运行时已就绪。
     *
     * <p>MCP 注册表必须显式注入：4 参构造器会将 {@code mcpRegister} 置空，
     * 使子代理请求拿不到 MCP 工具。</p>
     */
    public SubAgent(@Lazy RuntimeFactory defaultRuntimeFactory,
                    RequestModelInvokerFactory modelInvokerFactory,
                    WorkspaceManager workspaceManager,
                    @Qualifier("chatModelConfig") ModelConfig modelConfig,
                    McpRegister mcpRegister) {
        super(defaultRuntimeFactory, modelInvokerFactory, workspaceManager, modelConfig, mcpRegister);
    }


    @Override
    public String id() {
        return "";
    }
}

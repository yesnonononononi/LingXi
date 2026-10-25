package com.summit.dp.workflow.infrastructure.harness.agent;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.SensitiveDataProvider;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.runtime.agent.ChatAgent;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

@Component
public class SubAgent extends ChatAgent {

    /**
     * RuntimeFactory 惰性注入：defaultRuntimeFactory 依赖工具注册表，而注册表里的委派工具又依赖 SubAgent，
     * 直接注入会构成循环依赖。惰性代理把解析推迟到真正执行子 Agent 时，此时运行时已就绪。
     */
    public SubAgent(@Lazy RuntimeFactory defaultRuntimeFactory,
                    RequestModelInvokerFactory modelInvokerFactory,
                    WorkspaceResolver workspaceResolver,
                    @Qualifier("chatModelConfig") ModelConfig modelConfig,
                    ScopeMcpProvider scopeMcpProvider,
                    ExecutionRepository executionRepository,
                    ExecutionControl executionControl,
                    SensitiveDataProvider<McpConfig> mcpConfigSensitiveDataProvider,
                    SensitiveDataProvider<ModelConfig> modelConfigSensitiveDataProvider) {
        super(defaultRuntimeFactory, modelInvokerFactory, workspaceResolver, scopeMcpProvider, modelConfig,
                executionRepository, executionControl, mcpConfigSensitiveDataProvider, modelConfigSensitiveDataProvider);
    }

    @Override
    public String id() {
        return "";
    }
}

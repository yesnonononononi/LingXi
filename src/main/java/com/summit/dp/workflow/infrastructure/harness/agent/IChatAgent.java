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

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;
import org.springframework.context.annotation.Primary;

import com.summit.runtime.agent.ChatAgent;

@Component
@Primary
public class IChatAgent extends ChatAgent {

    /** 两类配置必须分别注入，恢复时才能按原版本取回连接参数。 */
    public IChatAgent(RuntimeFactory defaultRuntimeFactory,
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
        return "chatAgent";
    }
}

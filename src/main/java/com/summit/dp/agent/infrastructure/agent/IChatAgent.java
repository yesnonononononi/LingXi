package com.summit.dp.agent.infrastructure.agent;

import com.summit.core.conf.ModelConfig;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
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
     * {@link ScopeMcpProvider} 必须显式传在第 5 位：传成 null 会让
     * {@code ChatAgent#openMcpScope} 恒走 {@code McpToolScope.EMPTY}，请求级 MCP 工具静默失效。
     *
     * <p>{@code executionRepository} / {@code executionControl} 是框架构造器新增的执行协作者，
     * 容器注入即可（业务侧 {@code LocalExecutionRepository} 即为 {@code ExecutionRepository} 实现）。</p>
     */
    public IChatAgent(RuntimeFactory defaultRuntimeFactory,
                      RequestModelInvokerFactory modelInvokerFactory,
                      WorkspaceManager workspaceManager,
                      @Qualifier("chatModelConfig") ModelConfig modelConfig,
                      ScopeMcpProvider scopeMcpProvider,
                      ExecutionRepository executionRepository,
                      ExecutionControl executionControl) {
        super(defaultRuntimeFactory, modelInvokerFactory, workspaceManager, modelConfig, scopeMcpProvider,
                executionRepository, executionControl);
    }

    @Override
    public String id() {
        return "chatAgent";
    }
}

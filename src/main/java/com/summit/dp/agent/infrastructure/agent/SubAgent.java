package com.summit.dp.agent.infrastructure.agent;


import com.summit.core.conf.ModelConfig;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.runtime.RuntimeFactory;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
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
     * <p>{@link ScopeMcpProvider} 必须显式传在第 5 位：传成 null 会让子代理请求拿不到 MCP 工具。
     * {@code executionRepository} / {@code executionControl} 为框架构造器新增的执行协作者，容器注入即可。</p>
     */
    public SubAgent(@Lazy RuntimeFactory defaultRuntimeFactory,
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
        return "";
    }
}

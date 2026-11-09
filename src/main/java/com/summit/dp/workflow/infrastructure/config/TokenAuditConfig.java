package com.summit.dp.workflow.infrastructure.config;

import com.summit.core.audit.TokenAuditor;
import com.summit.core.compact.Tokenizer;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolRegistry;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.agent.ChatAgent;
import com.summit.runtime.audit.DefaultTokenAuditor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

@Configuration(proxyBeanMethods = false)
public class TokenAuditConfig {
    @Bean
    @ConditionalOnMissingBean(TokenAuditor.class)
    public TokenAuditor tokenAuditor(Tokenizer tokenizer, AgentConfig agentConfig, ToolRegistry toolRegistry,
                                     ObjectProvider<ChatAgent> agents) {
        return new DefaultTokenAuditor(tokenizer, agentConfig, toolRegistry, execution -> {
            List<ToolDefinition<?>> definitions = agents.orderedStream()
                    .flatMap(agent -> agent.disclosedMcpToolDefinitions(execution.getId()).stream())
                    .toList();
            // 检查点不保存 MCP 定义，执行域关闭后不能把未知的用量记成零。
            if (definitions.isEmpty() && execution.getAgentRequest().getMcpConfigSpec() != null) {
                throw new IllegalStateException("执行的 MCP 工具定义不可用");
            }
            return definitions;
        });
    }
}

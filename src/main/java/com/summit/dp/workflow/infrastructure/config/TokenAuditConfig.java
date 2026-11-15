package com.summit.dp.workflow.infrastructure.config;

import com.summit.core.audit.TokenAuditor;
import com.summit.core.compact.Tokenizer;
import com.summit.core.tool.ToolRegistry;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.audit.DefaultTokenAuditor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * token 审计的接线。
 *
 * <p><b>不再注入 MCP 定义</b>：远端工具从不单独进入模型工具表，一律经 {@code call_mcp_tool} 网关转发。
 * 因此模型为工具定义付的 token 就是「静态工具 + 网关」这一份，{@code DefaultTokenAuditor} 自己按
 * 注册表与请求名单算得出来，MCP 定义那一桶恒为零；外部再喂一份定义清单只会得到重复计数。</p>
 *
 * <p>远端工具的 schema 计在工具调用结果里（检索返回值），不属于定义桶——这也是查一条就付一次的原因。</p>
 */
@Configuration(proxyBeanMethods = false)
public class TokenAuditConfig {
    @Bean
    @ConditionalOnMissingBean(TokenAuditor.class)
    public TokenAuditor tokenAuditor(Tokenizer tokenizer, AgentConfig agentConfig, ToolRegistry toolRegistry) {
        return new DefaultTokenAuditor(tokenizer, agentConfig, toolRegistry);
    }
}

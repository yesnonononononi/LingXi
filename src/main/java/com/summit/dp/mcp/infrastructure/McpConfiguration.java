package com.summit.dp.mcp.infrastructure;

import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 宿主连接池始终需要工厂，工具可见性仍由请求决定。 */
@Configuration(proxyBeanMethods = false)
public class McpConfiguration {
    @Bean
    @ConditionalOnMissingBean(McpClientFactory.class)
    public McpClientFactory mcpClientFactory() {
        return new McpClientFactory();
    }
}

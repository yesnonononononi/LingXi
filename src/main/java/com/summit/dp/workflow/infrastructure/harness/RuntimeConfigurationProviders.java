package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.conf.McpConfig;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SensitiveDataProvider;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 框架只拿版本引用，凭据查询留在业务侧。 */
@Configuration(proxyBeanMethods = false)
public class RuntimeConfigurationProviders {
    @Bean
    public SensitiveDataProvider<ModelConfig> modelConfigSensitiveDataProvider(RuntimeConfigurationService configurations) {
        return configurations::resolveModel;
    }

    @Bean
    public SensitiveDataProvider<McpConfig> mcpConfigSensitiveDataProvider(RuntimeConfigurationService configurations) {
        return configurations::resolveMcp;
    }
}

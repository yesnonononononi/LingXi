package com.summit.dp.workflow.infrastructure.config;

import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import org.springframework.beans.factory.annotation.Value;
import java.nio.file.Path;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 运行资源延迟校验，缺少依赖不影响本地模式启动。 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SandboxProperties.class)
public class SandboxConfiguration {
    @Bean public ConfiguredSandboxWorkspaceProvider sandboxWorkspaceProvider(SandboxProperties properties) {
        return new ConfiguredSandboxWorkspaceProvider(properties);
    }
    @Bean
    public SandboxPolicyFactory sandboxPolicyFactory(SandboxProperties properties, SecurityRuleService rules,
            @Value("${lingxi.config.sandbox-security.directory:${user.home}/.lingxi/config}") String directory) {
        return new SandboxPolicyFactory(properties.environment(), () -> {
                    rules.rules(SecurityCategory.NET);
                    return rules.rules(SecurityCategory.FILES);
                },
                Path.of(directory), properties.applicationDirectory());
    }
}

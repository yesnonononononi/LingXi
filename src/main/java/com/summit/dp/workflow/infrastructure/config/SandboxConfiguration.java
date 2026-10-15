package com.summit.dp.workflow.infrastructure.config;

import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
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
    @Bean public SandboxPolicyFactory sandboxPolicyFactory(SandboxProperties properties) {
        return new SandboxPolicyFactory(properties.readonlyPaths(), properties.readwritePaths(), properties.environment());
    }
}

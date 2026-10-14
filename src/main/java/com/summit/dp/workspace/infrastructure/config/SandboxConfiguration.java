package com.summit.dp.workspace.infrastructure.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 只注册接入协作者，切换到沙箱并解析工作区时才检查运行资源。 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SandboxProperties.class)
public class SandboxConfiguration {
    @Bean
    public ConfiguredSandboxWorkspaceProvider sandboxWorkspaceProvider(SandboxProperties properties, ObjectMapper mapper) {
        return new ConfiguredSandboxWorkspaceProvider(properties, mapper);
    }

    @Bean
    public SandboxPolicyFactory sandboxPolicyFactory(SandboxProperties properties) {
        return new SandboxPolicyFactory(properties.allowedDomains(), properties.denyRead(), properties.denyWrite());
    }
}

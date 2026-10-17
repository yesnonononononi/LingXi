package com.summit.dp.workflow.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

/**
 * 运行资源按宿主平台部署，Windows 使用原生 BaseContainer。
 */
@ConfigurationProperties("lingxi.sandbox")
public record SandboxProperties(
        Path applicationDirectory,
        Path stateDirectory,
        Duration startupTimeout,
        Duration fileTimeout,
        Map<String, String> environment
) {
    public SandboxProperties {
        applicationDirectory = applicationDirectory == null ? null : applicationDirectory.toAbsolutePath().normalize();
        stateDirectory = (stateDirectory == null ? Path.of(System.getProperty("user.home"), ".lingxi", "sandbox")
                : stateDirectory).toAbsolutePath().normalize();
        startupTimeout = startupTimeout == null ? Duration.ofSeconds(30) : startupTimeout;
        fileTimeout = fileTimeout == null ? Duration.ofSeconds(30) : fileTimeout;
        environment = Map.copyOf(environment == null ? Map.of() : environment);
        if (applicationDirectory != null) environment = SandboxRuntimeLayout.resolve(applicationDirectory).commandEnvironment(environment);
    }

    public String nodeExecutable() {
        return applicationDirectory == null ? null : SandboxRuntimeLayout.resolve(applicationDirectory).nodeExecutable().toString();
    }

    public String sdkDirectory() {
        return applicationDirectory == null ? null : SandboxRuntimeLayout.resolve(applicationDirectory).sdkDirectory().toString();
    }

    public Path runtimeDirectory() {
        return applicationDirectory == null ? null : SandboxRuntimeLayout.resolve(applicationDirectory).directory();
    }
}

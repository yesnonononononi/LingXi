package com.summit.dp.workspace.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

/** 桌面启动器注入运行目录；部署配置只保留运行资源和网络规则。 */
@ConfigurationProperties("lingxi.sandbox")
public record SandboxProperties(Path applicationDirectory, Path nodeExe, Path srtCli, Path stateDirectory,
                                Duration timeout, List<String> allowedDomains, Path bashExe) {
    public SandboxProperties {
        timeout = timeout == null ? Duration.ofSeconds(60) : timeout;
        allowedDomains = allowedDomains == null ? List.of() : List.copyOf(allowedDomains);
    }
}

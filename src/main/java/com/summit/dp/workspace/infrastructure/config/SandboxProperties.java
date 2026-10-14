package com.summit.dp.workspace.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

/** 运行资源由部署方指定，业务不探测开发机的全局安装位置。 */
@ConfigurationProperties("lingxi.sandbox")
public record SandboxProperties(Path applicationDirectory, Path nodeExe, Path srtCli, Path stateDirectory,
                                Duration timeout, List<String> allowedDomains,
                                List<String> denyRead, List<String> denyWrite) {
    public SandboxProperties {
        timeout = timeout == null ? Duration.ofSeconds(60) : timeout;
        allowedDomains = allowedDomains == null ? List.of() : List.copyOf(allowedDomains);
        denyRead = denyRead == null ? List.of() : List.copyOf(denyRead);
        denyWrite = denyWrite == null ? List.of() : List.copyOf(denyWrite);
    }
}

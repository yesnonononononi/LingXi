package com.summit.dp.workflow.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Locale;

/** 运行资源按宿主平台部署，Windows 使用原生 BaseContainer。 */
@ConfigurationProperties("lingxi.sandbox")
public record SandboxProperties(Path applicationDirectory, String nodeExecutable, String sdkDirectory,
                                Duration startupTimeout, Duration fileTimeout, List<String> readonlyPaths,
                                List<String> readwritePaths, Map<String, String> environment) {
    public SandboxProperties {
        startupTimeout = startupTimeout == null ? Duration.ofSeconds(30) : startupTimeout;
        fileTimeout = fileTimeout == null ? Duration.ofSeconds(30) : fileTimeout;
        readonlyPaths = readonlyPaths == null ? List.of() : List.copyOf(readonlyPaths);
        readwritePaths = readwritePaths == null ? List.of() : List.copyOf(readwritePaths);
        Map<String, String> commandEnvironment = new LinkedHashMap<>(environment == null ? Map.of() : environment);
        if (nodeExecutable != null && nodeExecutable.startsWith("/") && nodeExecutable.lastIndexOf('/') > 0) {
            commandEnvironment.putIfAbsent("PATH", nodeExecutable.substring(0, nodeExecutable.lastIndexOf('/')) + ":/usr/bin:/bin");
        } else if (nodeExecutable != null && System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows")
                && Path.of(nodeExecutable).isAbsolute()) {
            commandEnvironment.putIfAbsent("PATH", Path.of(nodeExecutable).getParent() + ";" + System.getenv("SystemRoot") + "\\System32");
        }
        environment = Map.copyOf(commandEnvironment);
    }
}

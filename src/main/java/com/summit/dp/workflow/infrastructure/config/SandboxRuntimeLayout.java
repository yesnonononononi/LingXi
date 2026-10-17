package com.summit.dp.workflow.infrastructure.config;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 组件布局由后端掌握，安装位置变化不需要启动器逐项配置。 */
public record SandboxRuntimeLayout(Path directory, boolean windows) {
    public static SandboxRuntimeLayout resolve(Path applicationDirectory) {
        Path root = applicationDirectory.toAbsolutePath().normalize();
        // 用源码清单识别开发布局，运行资源未准备时也不会误选安装包目录。
        Path directory = Files.isRegularFile(root.resolve("frontend/package.json"))
                ? root.resolve("frontend/build/runtime") : root.resolve("resources/runtime");
        return new SandboxRuntimeLayout(directory,
                System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows"));
    }

    public Path nodeExecutable() { return directory.resolve(windows ? "node/node.exe" : "node/node"); }
    public Path gitExecutable() { return directory.resolve(windows ? "git/cmd/git.exe" : "git/bin/git"); }
    public Path bashExecutable() { return directory.resolve(windows ? "git/bin/bash.exe" : "git/bin/bash"); }
    public Path sdkDirectory() { return directory.resolve("mxc/node_modules/@microsoft/mxc-sdk"); }

    public Map<String, String> commandEnvironment(Map<String, String> overrides) {
        Map<String, String> result = new LinkedHashMap<>(overrides);
        boolean configuredPath = result.keySet().stream().anyMatch(key -> windows ? key.equalsIgnoreCase("PATH") : key.equals("PATH"));
        if (!configuredPath) {
            List<String> directories = windows ? List.of(directory.resolve("node").toString(),
                    directory.resolve("git/cmd").toString(), directory.resolve("git/bin").toString(),
                    Path.of(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"), "System32").toString())
                    : List.of(directory.resolve("node").toString(), directory.resolve("git/bin").toString(), "/usr/bin", "/bin");
            result.put("PATH", String.join(windows ? ";" : ":", directories));
        }
        return Map.copyOf(result);
    }
}

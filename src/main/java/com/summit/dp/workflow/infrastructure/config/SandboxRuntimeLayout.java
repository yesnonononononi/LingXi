package com.summit.dp.workflow.infrastructure.config;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
            List<String> directories = new ArrayList<>(windows ? List.of(directory.resolve("node").toString(),
                    directory.resolve("git/cmd").toString(), directory.resolve("git/bin").toString(),
                    Path.of(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"), "System32").toString())
                    : List.of(directory.resolve("node").toString(), directory.resolve("git/bin").toString(), "/usr/bin", "/bin"));
            // Windows 沙箱原先只有「自带 node/git + System32」这四段，宿主安装的 CLI（docker、python、
            // java…）一律找不到，命令直接报 not recognized。自带工具必须优先，所以把宿主 PATH 追加在
            // 末尾：PATH 只决定「去哪找」，能否读写/联网仍由沙箱策略裁决（绝对路径本来就能调用）。
            String inherited = System.getenv("PATH");
            if (windows && inherited != null && !inherited.isBlank()) directories.add(inherited);
            result.put("PATH", String.join(windows ? ";" : ":", directories));
        }
        return Map.copyOf(result);
    }
}

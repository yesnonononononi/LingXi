package com.summit.dp.workflow.infrastructure.config;

import com.summit.sandbox.mxc.MxcWorkspaceSpec;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** 宿主环境只在创建运行对象时合并，避免凭据进入会话保存的工作区规格。 */
public final class SandboxHostEnvironment {
    private SandboxHostEnvironment() { }

    public static MxcWorkspaceSpec inherit(MxcWorkspaceSpec spec) {
        return inherit(spec, System.getenv(), System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("windows"));
    }

    static MxcWorkspaceSpec inherit(MxcWorkspaceSpec spec, Map<String, String> host, boolean windows) {
        Map<String, String> environment = new LinkedHashMap<>();
        // 框架只接受这些环境键，Windows 的特殊驱动器键和带括号的键不能直接传入。
        host.forEach((key, value) -> {
            if (key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
                environment.put(windows ? key.toUpperCase(Locale.ROOT) : key, value);
            }
        });
        spec.environment().forEach((key, value) -> environment.put(windows ? key.toUpperCase(Locale.ROOT) : key, value));
        return new MxcWorkspaceSpec(spec.workDir(), spec.scope(), spec.readonlyPaths(), spec.readwritePaths(),
                environment, spec.writable(), spec.securityPolicy());
    }
}

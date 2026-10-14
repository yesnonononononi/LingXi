package com.summit.dp.workspace.infrastructure.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceProvider;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.exception.ClientException;
import com.summit.sandbox.CommandTimeoutConfig;
import com.summit.sandbox.SandboxWorkspaceProvider;

import java.util.concurrent.TimeUnit;
import java.util.Objects;

/** 保留框架的初始化失败边界，向业务提供明确的部署配置提示。 */
public final class ConfiguredSandboxWorkspaceProvider implements WorkspaceProvider {
    private final SandboxProperties properties;
    private final ObjectMapper mapper;

    public ConfiguredSandboxWorkspaceProvider(SandboxProperties properties, ObjectMapper mapper) {
        this.properties = properties;
        this.mapper = mapper;
    }

    @Override
    public String type() {
        return SandboxWorkspaceProvider.TYPE;
    }

    @Override
    public Workspace resolve(WorkspaceSpec spec) {
        throwIf(Objects.toString(properties.applicationDirectory(), "").isBlank()
                        || Objects.toString(properties.nodeExe(), "").isBlank() || Objects.toString(properties.srtCli(), "").isBlank(),
                "沙箱运行资源未配置，请设置 lingxi.sandbox 的 application-directory、node-exe 和 srt-cli");
        throwIf(properties.timeout().isNegative() || properties.timeout().isZero(), "沙箱执行超时必须大于零");
        try {
            return SandboxWorkspaceProvider.builder().applicationDirectory(properties.applicationDirectory())
                    .nodeExe(properties.nodeExe()).srtCli(properties.srtCli()).bashExe(properties.bashExe())
                    .stateDirectory(properties.stateDirectory())
                    .objectMapper(mapper).timeout(new CommandTimeoutConfig(properties.timeout().toMillis(), TimeUnit.MILLISECONDS))
                    .build().resolve(spec);
        } catch (RuntimeException failure) {
            ClientException error = new ClientException("沙箱初始化失败，请检查运行资源和权限策略：" + failure.getMessage());
            error.initCause(failure);
            throw error;
        }
    }

    private void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }
}

package com.summit.dp.workflow.infrastructure.config;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceProvider;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workspace.application.service.SandboxService;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import com.summit.sandbox.mxc.MxcRuntime;
import com.summit.sandbox.mxc.MxcPlatformProbe;
import com.summit.sandbox.mxc.MxcWorkspaceProvider;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import lombok.extern.slf4j.Slf4j;
import java.io.IOException;
import java.util.Locale;

/** 框架执行对象只在工作流接入，业务通过状态接口发起检查。 */
@Slf4j
public final class ConfiguredSandboxWorkspaceProvider implements WorkspaceProvider, SandboxService {
    private final SandboxProperties properties;
    public ConfiguredSandboxWorkspaceProvider(SandboxProperties properties) { this.properties = properties; }
    @Override public String type() { return MxcWorkspaceProvider.TYPE; }

    @Override public Workspace resolve(WorkspaceSpec spec) {
        SandboxServiceStatus status = inspect();
        throwIf(!status.configured(), status.message());
        throwIf(!(spec instanceof MxcWorkspaceSpec), "沙箱工作区规格无效，请重新选择工作空间");
        try {
            MxcRuntime runtime = new MxcRuntime(properties.nodeExecutable(),
                    properties.sdkDirectory(), properties.applicationDirectory().resolve("helpers"),
                    properties.startupTimeout(), properties.fileTimeout());
            return new MxcWorkspaceProvider(runtime).resolve(spec);
        } catch (RuntimeException failure) {
            log.error("沙箱初始化失败: backend={}, directory={}", status.backend(), properties.applicationDirectory(), failure);
            throw new ClientException("沙箱初始化失败，请检查宿主 Node、MXC SDK 及原生隔离能力，详情见日志");
        }
    }

    @Override public SandboxServiceStatus inspect() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String backend = os.contains("win") ? "BaseContainer" : "Bubblewrap";
        boolean configured = (os.contains("win") || os.contains("linux")) && properties.applicationDirectory() != null
                && properties.nodeExecutable() != null && !properties.nodeExecutable().isBlank()
                && properties.sdkDirectory() != null && !properties.sdkDirectory().isBlank()
                && !properties.startupTimeout().isNegative() && !properties.startupTimeout().isZero()
                && !properties.fileTimeout().isNegative() && !properties.fileTimeout().isZero();
        return new SandboxServiceStatus(configured, false, backend, configured ? "沙箱资源已配置，请运行检查确认可用"
                : "沙箱运行资源未配置，请配置 application-directory、宿主 node-executable 和 sdk-directory");
    }

    @Override public SandboxServiceStatus check() {
        SandboxServiceStatus status = inspect();
        throwIf(!status.configured(), status.message());
        MxcPlatformProbe.Result capability;
        try {
            MxcRuntime runtime = new MxcRuntime(properties.nodeExecutable(), properties.sdkDirectory(),
                    properties.applicationDirectory().resolve("helpers"), properties.startupTimeout(), properties.fileTimeout());
            capability = MxcPlatformProbe.check(runtime);
        } catch (IOException | InterruptedException | RuntimeException failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            log.error("沙箱能力检查失败: backend={}", status.backend(), failure);
            throw new ClientException("沙箱基础能力检查失败，请检查宿主 Node、MXC SDK 和系统支持，详情见日志");
        }
        log.info("沙箱能力检查完成: backend={}, available={}, detail={}", capability.backend(), capability.available(), capability.detail());
        throwIf(!capability.available(), "沙箱基础能力不可用，详情见日志");
        return new SandboxServiceStatus(true, true, capability.backend(), "沙箱基础能力可用，项目执行时仍会校验实际权限");
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
}

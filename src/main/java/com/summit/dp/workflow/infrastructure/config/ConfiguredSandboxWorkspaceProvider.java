package com.summit.dp.workflow.infrastructure.config;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.workspace.WorkspaceProvider;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workspace.application.service.SandboxService;
import com.summit.dp.workspace.application.vo.SandboxServiceStatus;
import com.summit.sandbox.mxc.MxcRuntime;
import com.summit.sandbox.mxc.MxcWorkspaceProvider;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import lombok.extern.slf4j.Slf4j;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

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
            boolean windows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
            MxcRuntime runtime = new MxcRuntime(windows ? properties.distribution() : null, properties.nodeExecutable(),
                    properties.sdkDirectory(), properties.applicationDirectory().resolve("helpers"),
                    properties.startupTimeout(), properties.fileTimeout());
            return new MxcWorkspaceProvider(runtime).resolve(spec);
        } catch (RuntimeException failure) {
            log.error("沙箱初始化失败: distribution={}, directory={}", properties.distribution(), properties.applicationDirectory(), failure);
            throw new ClientException("沙箱初始化失败，请检查 Linux Node、MXC SDK 和 Bubblewrap 配置，详情见日志");
        }
    }

    @Override public SandboxServiceStatus inspect() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String backend = os.contains("win") ? "WSL/Bubblewrap" : "Bubblewrap";
        boolean configured = (os.contains("win") || os.contains("linux")) && properties.applicationDirectory() != null
                && properties.nodeExecutable() != null && !properties.nodeExecutable().isBlank()
                && properties.sdkDirectory() != null && !properties.sdkDirectory().isBlank()
                && (!os.contains("win") || properties.distribution() != null && !properties.distribution().isBlank())
                && !properties.startupTimeout().isNegative() && !properties.startupTimeout().isZero()
                && !properties.fileTimeout().isNegative() && !properties.fileTimeout().isZero();
        return new SandboxServiceStatus(configured, false, backend, configured ? "沙箱资源已配置，请运行检查确认可用"
                : "沙箱运行资源未配置，请配置 application-directory、Linux node-executable、sdk-directory；Windows 还需指定 distribution");
    }

    @Override public SandboxServiceStatus check() {
        throwIf(!inspect().configured(), inspect().message());
        Path directory = properties.applicationDirectory().toAbsolutePath().normalize().resolve("checks").resolve(UUID.randomUUID().toString());
        Path root = directory.resolve("workspace");
        Path outside = directory.resolve("outside.txt");
        try {
            Files.createDirectories(root);
            Files.writeString(outside, "protected");
            Workspace workspace = resolve(new MxcWorkspaceSpec(root.toString()));
            Path file = workspace.resolve("check.txt");
            workspace.bridge().writeString(file, "沙箱文件检查", StandardCharsets.UTF_8);
            throwIf(!"沙箱文件检查".equals(workspace.bridge().readString(file, StandardCharsets.UTF_8)), "沙箱文件读取结果不一致");
            workspace.bridge().deleteFile(file);
            throwIf(workspace.bridge().exists(file), "沙箱文件删除检查失败");
            boolean readBlocked = false;
            try { workspace.bridge().readString(outside, StandardCharsets.UTF_8); } catch (IOException expected) { readBlocked = true; }
            boolean writeBlocked = false;
            try { workspace.bridge().writeString(outside, "changed", StandardCharsets.UTF_8); } catch (IOException expected) { writeBlocked = true; }
            log.info("沙箱边界检查: readBlocked={}, writeBlocked={}, directory={}", readBlocked, writeBlocked, directory);
            throwIf(!readBlocked || !writeBlocked || !"protected".equals(Files.readString(outside)), "沙箱未拒绝工作区外的文件访问");
            WorkspaceBridge.CommandResult command = workspace.bridge().execute("printf mxc-backend-ok", workspace.workDir(),
                    StandardCharsets.UTF_8, 10, TimeUnit.SECONDS, 4096);
            throwIf(command.timedOut() || command.exitCode() != 0 || !command.output().equals("mxc-backend-ok"), "沙箱终端命令检查失败");
            log.info("沙箱检查通过: backend={}, directory={}", inspect().backend(), directory);
            return new SandboxServiceStatus(true, true, inspect().backend(), "沙箱可用：命令执行和文件读写通过，工作区外读写已拒绝");
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            log.error("沙箱检查失败: directory={}", directory, failure);
            throw new ClientException("沙箱检查失败，详情见日志");
        } finally {
            for (Path path : new Path[] { root.resolve("check.txt"), outside, root, directory }) {
                try { Files.deleteIfExists(path); } catch (IOException failure) { log.warn("沙箱检查文件清理失败: path={}", path, failure); }
            }
        }
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
}

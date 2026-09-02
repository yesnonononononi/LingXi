package com.summit.dp.workspace.infrastructure.converter;

import com.summit.core.runtime.LocalWorkspaceBridge;
import com.summit.core.runtime.OsType;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.ShellType;
import com.summit.core.runtime.Workspace;
import com.summit.core.runtime.WorkspaceBridge;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 本地工作空间（业务侧实现框架 {@link Workspace} 接口）。
 * <p>框架运行时未提供 local 形态的 Workspace 实现（runtime 仅 {@code DockerWorkspace}），
 * 此处按框架契约自建：命令执行与文件 IO 走主机 {@link LocalWorkspaceBridge}，
 * 工作目录为主机绝对路径，路径解析时做工作区越界校验。</p>
 */
public final class LocalWorkspace implements Workspace {

    private final String id;
    private final String workDir;
    private final RuntimeEnvironment runtimeEnvironment;

    private LocalWorkspace(String id, String workDir, RuntimeEnvironment runtimeEnvironment) {
        this.id = id;
        this.workDir = workDir;
        this.runtimeEnvironment = runtimeEnvironment;

    }

    public static LocalWorkspace of(String id, String workDir) {
        return new LocalWorkspace(id, workDir, hostEnvironment());
    }

    @Override
    public String id() {
        return id;
    }

    @Override
    public RuntimeEnvironment runtimeEnvironment() {
        return runtimeEnvironment;
    }

    @Override
    public String workDir() {
        return workDir;
    }

    @Override
    public Path resolve(String path) {
        if (path == null || path.isBlank()) {
            throw new IllegalArgumentException("path must not be blank");
        }
        Path root = Paths.get(workDir).toAbsolutePath().normalize();
        Path target = Paths.get(path).toAbsolutePath().normalize();
        if (!target.startsWith(root)) {
            throw new IllegalArgumentException("File path is out of workspace: " + path);
        }
        return target;
    }

    @Override
    public WorkspaceBridge bridge() {
        return LocalWorkspaceBridge.INSTANCE;
    }

    /**
     * 依据当前主机推导运行时环境（osType/shellType 对应主机可用的执行器）。
     */
    private static RuntimeEnvironment hostEnvironment() {
        String os = System.getProperty("os.name", "").toLowerCase();
        OsType osType = os.contains("win") ? OsType.WINDOWS
                : os.contains("mac") ? OsType.MACOS : OsType.LINUX;
        ShellType shellType = os.contains("win") ? ShellType.CMD
                : os.contains("mac") ? ShellType.ZSH : ShellType.BASH;
        return RuntimeEnvironment.builder()
                .osType(osType)
                .shellType(shellType)
                .charset(StandardCharsets.UTF_8)
                .build();
    }
}

package com.summit.dp.workspace.application.policy;

import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.sandbox.SandboxPolicy;

import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** 权限档位只在这里转换成沙箱策略，工具执行器不感知 SRT。 */
public final class SandboxPolicyFactory {
    private final List<String> allowedDomains;
    private final FileSystem fileSystem;

    public SandboxPolicyFactory(List<String> allowedDomains) {
        this(allowedDomains, FileSystems.getDefault());
    }

    public SandboxPolicyFactory(List<String> allowedDomains, FileSystem fileSystem) {
        this.allowedDomains = List.copyOf(allowedDomains);
        this.fileSystem = Objects.requireNonNull(fileSystem);
    }

    public SandboxPolicy build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = accessMode == null ? AgentAccessMode.DEFAULT : accessMode;
        List<String> project = List.of(workDir);
        List<String> writes = project;
        if (effective.allowsOutsideWrite()) {
            // 每次请求重新枚举挂载根目录，不固化盘符或部署机器路径。
            List<String> roots = new ArrayList<>();
            for (Path root : fileSystem.getRootDirectories()) roots.add(root.toAbsolutePath().normalize().toString());
            writes = List.copyOf(roots);
        }
        return SandboxPolicy.builder().restrictWrites(!effective.allowsOutsideWrite()).allowedDomains(allowedDomains).allowRead(project)
                .allowWrite(effective.allowsWriteTools() ? writes : List.of())
                .denyWrite(effective.allowsWriteTools() ? List.of() : project).build();
    }
}

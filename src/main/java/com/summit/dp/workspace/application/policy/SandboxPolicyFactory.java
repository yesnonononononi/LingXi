package com.summit.dp.workspace.application.policy;

import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.sandbox.SandboxPolicy;

import java.util.List;

/** 权限档位只在这里转换成沙箱策略，工具执行器不感知 SRT。 */
public final class SandboxPolicyFactory {
    private final List<String> allowedDomains;

    public SandboxPolicyFactory(List<String> allowedDomains) {
        this.allowedDomains = List.copyOf(allowedDomains);
    }

    public SandboxPolicy build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = AgentAccessMode.effective(accessMode, WorkspaceType.SAND_BOX);
        List<String> project = List.of(workDir);
        return SandboxPolicy.builder().allowedDomains(allowedDomains).allowRead(project)
                .allowWrite(effective.allowsWriteTools() ? project : List.of())
                .denyWrite(effective.allowsWriteTools() ? List.of() : project).build();
    }
}

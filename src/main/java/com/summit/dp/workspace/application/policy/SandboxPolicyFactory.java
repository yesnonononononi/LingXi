package com.summit.dp.workspace.application.policy;

import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.sandbox.SandboxPolicy;

import java.util.ArrayList;
import java.util.List;

/** 权限档位只在这里转换成沙箱策略，工具执行器不感知 SRT。 */
public final class SandboxPolicyFactory {
    private final List<String> allowedDomains;
    private final List<String> denyRead;
    private final List<String> denyWrite;

    public SandboxPolicyFactory(List<String> allowedDomains, List<String> denyRead, List<String> denyWrite) {
        this.allowedDomains = List.copyOf(allowedDomains);
        this.denyRead = List.copyOf(denyRead);
        this.denyWrite = List.copyOf(denyWrite);
    }

    public SandboxPolicy build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = AgentAccessMode.effective(accessMode, WorkspaceType.SAND_BOX);
        List<String> deniedWrites = new ArrayList<>(denyWrite);
        if (!effective.allowsWriteTools()) deniedWrites.add(workDir);
        return SandboxPolicy.builder().allowedDomains(allowedDomains).denyRead(denyRead)
                .denyWrite(deniedWrites).build();
    }
}

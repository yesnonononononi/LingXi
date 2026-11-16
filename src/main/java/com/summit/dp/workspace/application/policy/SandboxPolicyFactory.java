package com.summit.dp.workspace.application.policy;

import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;

import java.util.Map;

/** 构造 Windows 沙箱工作区规格。 */
public final class SandboxPolicyFactory {
    private final Map<String, String> environment;

    public SandboxPolicyFactory(Map<String, String> environment) {
        this.environment = Map.copyOf(environment);
    }

    public WindowsWorkspaceSpec build(String workDir, AgentPermissionMode permissionMode) {
        AgentPermissionMode effective = permissionMode == null ? AgentPermissionMode.DEFAULT : permissionMode;
        return new WindowsWorkspaceSpec(workDir, LocalInstance.ID, environment, effective.isWorkspaceWritable());
    }
}

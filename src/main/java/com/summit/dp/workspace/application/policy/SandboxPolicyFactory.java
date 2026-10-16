package com.summit.dp.workspace.application.policy;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import java.util.List;
import java.util.Map;

/** 项目外授权由部署提供，不能把“完全访问”扩大为整个磁盘。 */
public final class SandboxPolicyFactory {
    private final Map<String, String> environment;

    public SandboxPolicyFactory( Map<String, String> environment) {
        this.environment = Map.copyOf(environment);
    }

    /** 工作区授权只声明一次，额外目录交给安全中心显式配置。 */
    public MxcWorkspaceSpec build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = accessMode == null ? AgentAccessMode.DEFAULT : accessMode;
        throwIf(effective.allowsOutsideWrite(), "当前沙箱不支持完全访问，请使用本地模式");
        return new MxcWorkspaceSpec(workDir, LocalInstance.ID, List.of(), List.of(),
                environment, effective.allowsWriteTools());
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
}

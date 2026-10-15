package com.summit.dp.workspace.application.policy;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 项目外授权由部署提供，不能把“完全访问”扩大为整个磁盘。 */
public final class SandboxPolicyFactory {
    private final Map<String, String> environment;

    public SandboxPolicyFactory( Map<String, String> environment) {
        this.environment = Map.copyOf(environment);
    }

    /**
     * case READ_ONLY_IN_WORKSPACE: readPaths: [workdir],
     * case IN_WORKSPACE: readWritePaths: [workdir]
     */
    public MxcWorkspaceSpec build(String workDir, AgentAccessMode accessMode) {
        List<String> readonlyPaths = new ArrayList<>();
        List<String> readwritePaths = new ArrayList<>();

        AgentAccessMode effective = accessMode == null ? AgentAccessMode.DEFAULT : accessMode;

        throwIf(effective.allowsOutsideWrite(), "当前沙箱不支持完全访问，请使用本地模式");

        if(accessMode == AgentAccessMode.IN_WORKSPACE){
            readwritePaths = List.of(workDir);
        }
        else if(accessMode == AgentAccessMode.READ_ONLY_IN_WORKSPACE){
            readonlyPaths = List.of();
        }
        return new MxcWorkspaceSpec(
                workDir,
                LocalInstance.ID,
                readonlyPaths,
                effective.allowsOutsideWrite() ? readwritePaths : List.of(),
                environment,
                effective.allowsWriteTools()
        );
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
}

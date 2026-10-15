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
    private final List<String> readonlyPaths;
    private final List<String> readwritePaths;
    private final Map<String, String> environment;
    public SandboxPolicyFactory(List<String> readonlyPaths, List<String> readwritePaths, Map<String, String> environment) {
        this.readonlyPaths = List.copyOf(readonlyPaths);
        this.readwritePaths = List.copyOf(readwritePaths);
        this.environment = Map.copyOf(environment);
    }
    public MxcWorkspaceSpec build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = accessMode == null ? AgentAccessMode.DEFAULT : accessMode;
        throwIf(effective.allowsOutsideWrite() && readwritePaths.isEmpty(), "当前沙箱未配置项目外可写目录，请配置 readwrite-paths 或选择工作区内修改");
        List<String> reads = new ArrayList<>(readonlyPaths);
        if (!effective.allowsOutsideWrite()) reads.addAll(readwritePaths);
        return new MxcWorkspaceSpec(workDir, LocalInstance.ID, reads,
                effective.allowsOutsideWrite() ? readwritePaths : List.of(), environment, effective.allowsWriteTools());
    }
    private void throwIf(boolean condition, String message) { if (condition) throw new ClientException(message); }
}

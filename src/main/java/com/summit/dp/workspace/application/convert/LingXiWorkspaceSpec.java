package com.summit.dp.workspace.application.convert;

import com.summit.core.workspace.WorkspaceSpec;

import java.util.Map;

/** Local workspace 的框架规格，只存在于应用层转换边界。 */
public record LingXiWorkspaceSpec(String provider, String workDir, String scope,
                                 Map<String, String> configuration) implements WorkspaceSpec {
    public LingXiWorkspaceSpec {
        configuration = configuration == null ? Map.of() : Map.copyOf(configuration);
    }

    public LingXiWorkspaceSpec(String provider, String workDir, Map<String, String> configuration) {
        this(provider, workDir, null, configuration);
    }
}

package com.summit.dp.workspace.application.policy;

import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import com.summit.sandbox.mxc.MxcSecurityPolicy;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/** 隐私拒绝下沉到原生策略；Windows 普通路径不再按项目围栏。 */
public final class SandboxPolicyFactory {
    private final Map<String, String> environment;
    private final Supplier<List<SecurityRule>> fileRules;
    private final Path configDirectory;
    private final Path applicationDirectory;
    public SandboxPolicyFactory(Map<String, String> environment) {
        this(environment, () -> SecurityRulePresets.defaults(SecurityCategory.FILES),
                Path.of(System.getProperty("user.home"), ".lingxi", "config"), null);
    }
    public SandboxPolicyFactory(Map<String, String> environment, Supplier<List<SecurityRule>> fileRules,
                                Path configDirectory, Path applicationDirectory) {
        this.environment = Map.copyOf(environment);
        this.fileRules = fileRules;
        this.configDirectory = configDirectory.toAbsolutePath().normalize();
        this.applicationDirectory = applicationDirectory;
    }
    public MxcWorkspaceSpec build(String workDir, AgentAccessMode accessMode) {
        AgentAccessMode effective = accessMode == null ? AgentAccessMode.DEFAULT : accessMode;
        List<String> denied = new ArrayList<>(fileRules.get().stream()
                .filter(rule -> rule.enabled() && rule.read() == SecurityAction.DENY)
                .map(rule -> SecurityRuleService.expandPath(rule.pattern())).toList());
        denied.add(configDirectory.toString());
        List<String> readonly = new ArrayList<>();
        if (applicationDirectory != null && Files.isDirectory(applicationDirectory)) readonly.add(applicationDirectory.toString());
        Path stateDirectory = Path.of(System.getProperty("user.home"), ".lingxi");
        if (Files.isDirectory(stateDirectory)) readonly.add(stateDirectory.toString());
        boolean windows = File.separatorChar == '\\';
        List<String> volumes = windows ? Arrays.stream(File.listRoots()).map(File::getAbsolutePath).toList() : List.of();
        return new MxcWorkspaceSpec(workDir, LocalInstance.ID, readonly, List.of(), environment,
                effective.allowsWriteTools(), new MxcSecurityPolicy(denied, volumes, true));
    }
}

package com.summit.dp.workspace.application.convert;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.workspace.domain.model.Workspace;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.Map;

/** 运行类型和访问档位来自请求，工作空间记录只提供真实宿主目录。 */
@Component
@RequiredArgsConstructor
public class WorkspaceConverter {
    private static final WorkspaceType DEFAULT_TYPE = WorkspaceType.SAND_BOX;
    private final SettingsProvider settingsProvider;
    private final SandboxPolicyFactory sandboxPolicyFactory;

    public Workspace toDomain(Long id, WorkspaceSpec spec) {
        return spec == null || id == null ? null : new Workspace(id, "工作空间", spec.workDir());
    }

    public WorkspaceSpec toSpec(Workspace workspace, WorkspaceType type) {
        return toSpec(workspace, type, resolveAccessMode());
    }

    public WorkspaceSpec toSpec(Workspace workspace, WorkspaceType type, AgentAccessMode mode) {
        return workspace == null || workspace.getId() == null ? null : buildSpec(workspace.getHostDir(), type, mode);
    }

    public WorkspaceSpec toSpec(WorkspaceVO workspace, WorkspaceType type) {
        return toSpec(workspace, type, resolveAccessMode());
    }

    public WorkspaceSpec toSpec(WorkspaceVO workspace, WorkspaceType type, AgentAccessMode mode) {
        return workspace == null || workspace.id() == null ? null : buildSpec(workspace.hostDir(), type, mode);
    }

    public WorkspaceType resolveType() {
        return settingsProvider.current().map(SettingsView::workspaceType).orElse(DEFAULT_TYPE);
    }

    public String resolveWorkDir(Workspace workspace) {
        return workspace == null ? null : workspace.getHostDir();
    }

    private AgentAccessMode resolveAccessMode() {
        return AgentAccessMode.parse(settingsProvider.current().map(SettingsView::accessMode).orElse(null));
    }

    private WorkspaceSpec buildSpec(String hostDir, WorkspaceType type, AgentAccessMode mode) {
        if (hostDir == null || hostDir.isBlank()) throw new ClientException("工作空间缺少宿主目录，请重新配置工作空间");
        String workDir = Path.of(hostDir).toAbsolutePath().normalize().toString();
        WorkspaceType effective = type == null ? DEFAULT_TYPE : type;
        if (effective == WorkspaceType.SAND_BOX) {
            return sandboxPolicyFactory.build(hostDir.startsWith("/") ? hostDir : workDir, mode);
        }
        return new LingXiWorkspaceSpec("local", workDir, LocalInstance.ID, Map.of());
    }
}

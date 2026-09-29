package com.summit.dp.workspace.application.convert;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.sandbox.docker.DockerWorkspaceSpec;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/** workspace 领域模型与框架运行时模型的唯一转换入口。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class WorkspaceConverter {

    /** 与 {@code user_configs.workspace_type} 的列默认值一致，仅在该项缺失时兜底。 */
    private static final WorkspaceType DEFAULT_TYPE = WorkspaceType.SAND_BOX;

    private final SettingsProvider settingsProvider;

    /**
     * 规格是"期望状态"，不含业务主键；工作空间记录的 ID 由调用方显式给出。
     *
     * @param id   业务库中的工作空间主键
     * @param spec 框架侧的期望规格
     */
    public Workspace toDomain(Long id, WorkspaceSpec spec) {
        if (spec == null || id == null) return null;
        if (spec instanceof DockerWorkspaceSpec docker) {
            String name = docker.containerName() == null || docker.containerName().isBlank() ? "工作空间" : docker.containerName();
            return new Workspace(id, name, docker.hostDir());
        }
        return new Workspace(id, "工作空间", spec.workDir());
    }

    /**
     * 把工作空间转成框架运行时规格，运行类型由传入值决定。
     *
     * <p>类型不来自 workspace 行：同一个工作空间在切换运行模式前后应当跑在不同环境里，
     * 落库的 type 只会变成过期快照。因此调用方先读单例设置的 workspace_type，
     * 再把结果显式传进来。</p>
     *
     * @param type 运行类型；为 null 时按 {@link #DEFAULT_TYPE} 兜底
     */
    public WorkspaceSpec toSpec(Workspace workspace, WorkspaceType type) {
        if (workspace == null || workspace.getId() == null) return null;
        WorkspaceType effective = type == null ? DEFAULT_TYPE : type;
        String workDir = workDirOf(workspace, effective);

        // 本地单实例（HC-1）无账号归属；scope 是框架侧的隔离域标识，
        // 统一填本地实例常量 —— 语义稳定，不再随任何「归属」概念波动（T07 收口）。
        if (effective == WorkspaceType.SAND_BOX) {
            return DockerWorkspaceSpec.builder()
                    .workDir(workDir)
                    .containerName(workspace.getName())
                    .hostDir(workspace.getHostDir())
                    .reuseByHostDirectory(true)
                    .build();
        }
        return new LingXiWorkspaceSpec("local", workDir, LocalInstance.ID, Map.of());
    }

    /**
     * {@link #toSpec(Workspace, WorkspaceType)} 的 VO 重载。
     *
     * <p>workDir 在 VO 上已经算好，无需按类型重算；直接沿用即可，避免两个入口
     * 各自实现一遍目录推导而出现分歧。</p>
     */
    public WorkspaceSpec toSpec(WorkspaceVO workspace, WorkspaceType type) {
        if (workspace == null || workspace.id() == null) return null;
        WorkspaceType effective = type == null ? DEFAULT_TYPE : type;

        if (effective == WorkspaceType.SAND_BOX) {
            return DockerWorkspaceSpec.builder()
                    .workDir(workspace.workDir())
                    .containerName(workspace.name())
                    .hostDir(workspace.hostDir())
                    .reuseByHostDirectory(true)
                    .build();
        }
        return new LingXiWorkspaceSpec("local", workspace.workDir(), LocalInstance.ID, Map.of());
    }

    /**
     * 按单例设置解析运行类型，这是 type 的唯一来源。
     */
    public WorkspaceType resolveType() {
        WorkspaceType type = settingsProvider.current()
                .map(SettingsView::workspaceType)
                .orElse(null);
        if (type == null) {
            log.debug("未配置工作空间类型，回落到 {}", DEFAULT_TYPE.code());
            return DEFAULT_TYPE;
        }
        return type;
    }

    /**
     * 按单例设置解析运行目录，供 VO 装配使用 —— workDir 依赖运行类型，
     * 类型不在实体上，所以这里读设置。
     */
    public String resolveWorkDir(Workspace workspace) {
        if (workspace == null) return null;
        return workDirOf(workspace, resolveType());
    }

    /**
     * 容器内工作目录：local 用宿主目录本身，sandbox 用宿主目录的文件夹名。
     * 原为领域实体上的派生属性，类型外移后一并移到这里 —— 它是「怎么跑」的一部分。
     */
    private static String workDirOf(Workspace workspace, WorkspaceType type) {
        String hostDir = workspace.getHostDir();
        if (type == WorkspaceType.LOCAL) {
            return hostDir;
        }
        if (hostDir != null && !hostDir.isBlank()) {
            String folderName = extractFolderName(hostDir);
            if (folderName != null && !folderName.isBlank()) {
                return "/" + folderName;
            }
        }
        return null;
    }

    private static String extractFolderName(String path) {
        String normalized = path.replace('\\', '/');
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        int idx = normalized.lastIndexOf('/');
        if (idx >= 0 && idx < normalized.length() - 1) {
            return normalized.substring(idx + 1).trim();
        }
        return normalized.trim();
    }
}

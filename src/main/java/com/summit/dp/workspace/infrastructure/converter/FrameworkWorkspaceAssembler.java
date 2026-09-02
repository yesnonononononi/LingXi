package com.summit.dp.workspace.infrastructure.converter;

import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.runtime.sandbox.DockerWorkspace;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 业务工作空间 → 框架运行时工作空间（{@link com.summit.core.runtime.Workspace}）的装配器。
 * <p>装配结果会随 {@code ConversationEntity} 挂回会话实体，供运行期（如 {@code ConversationManager.workspace(sessionId)}）
 * 使用；会话持久化时再通过 {@code workspace.id()} 反向关联独立表。</p>
 *
 * <ul>
 *   <li>docker：恢复已有容器，直接以框架 {@link DockerWorkspace#attach} 续接（不新建容器）。</li>
 *   <li>local：返回业务自建 {@link LocalWorkspace}。</li>
 * </ul>
 */
@Slf4j
@Component
public class FrameworkWorkspaceAssembler {

    /**
     * 将业务工作空间装配为框架运行时实例；不可装配（数据缺失/类型非法）时返回 {@code null}，由调用方回退。
     */
    public com.summit.core.runtime.Workspace toFramework(Workspace workspace) {
        if (workspace == null) {
            return null;
        }
        try {
            return switch (workspace.getType()) {
                case DOCKER -> restoreDocker(workspace);
                case LOCAL -> LocalWorkspace.of(workspace.getId() == null ? null : workspace.getId().toString(),
                        workspace.getWorkDir());
            };
        } catch (Exception e) {
            log.warn("Failed to assemble framework workspace for workspace {}: {}", workspace.getId(), e.toString());
            return null;
        }
    }

    /**
     * 以已有容器 ID 恢复 DockerWorkspace（续接容器、不启动新容器）。
     * 容器 ID/工作目录缺失时不满足装配前置条件，返回 {@code null}，由调用方补建容器或报错。
     */
    private com.summit.core.runtime.Workspace restoreDocker(Workspace workspace) {
        if (workspace.getId() == null
                || workspace.getContainerId() == null || workspace.getContainerId().isBlank()
                || workspace.getWorkDir() == null || workspace.getWorkDir().isBlank()) {
            log.warn("Docker workspace {} incomplete: id/containerId/workDir must not be blank", workspace.getId());
            return null;
        }
        return DockerWorkspace.attach(
                workspace.getId().toString(),
                workspace.getContainerId(),
                workspace.getWorkDir());
    }
}

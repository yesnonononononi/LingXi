package com.summit.dp.workspace.domain.model;

import com.summit.ddd.domain.model.AggregateRoot;
import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * 工作空间领域实体（业务自建，独立于框架 {@code com.summit.core.runtime.Workspace}）。
 * <p>聚合承载一个可复用的运行环境（一个项目目录一般对应一个运行环境，可被多个会话共享）。
 * 表列、类型判别与校验规则完全由业务掌控；持久化时通过装配器与框架运行时实例互转。</p>
 */
@Getter
@AllArgsConstructor
public class Workspace extends AggregateRoot {
    private Long id;
    private String name;
    private WorkspaceType type;
    /** docker 为容器内绝对路径；local 为主机目录 */
    private String workDir;
    /** 仅 docker 类型允许非空，容器首次运行后回填 */
    private String containerId;

    public void rename(String name) {
        this.name = name;
    }

    public void changeWorkDir(String workDir) {
        this.workDir = workDir;
    }

    /**
     * 绑定/更新 docker 容器 ID。
     *
     * @throws IllegalArgumentException local 类型不可绑定，或容器 ID 为空
     */
    public void bindContainer(String containerId) {
        if (type != WorkspaceType.DOCKER) {
            throw new IllegalArgumentException("仅 docker 类型工作空间可绑定容器ID");
        }
        if (containerId == null || containerId.isBlank()) {
            throw new IllegalArgumentException("容器ID不能为空");
        }
        this.containerId = containerId;
    }
}

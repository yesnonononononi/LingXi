package com.summit.dp.workspace.application.command;

/**
 * 工作空间应用命令（add/update 共用）。
 *
 * @param id          更新时必填；新增时忽略
 * @param name        名称，可空（新增时默认“工作空间”）
 * @param type        docker/local；新增时空缺默认 docker，更新时不允许变更类型
 * @param workDir     工作目录，必填；docker 为容器内绝对路径(以 / 开头)，local 为主机绝对路径
 * @param containerId docker 容器 ID，仅 docker 类型允许，可空（容器运行后回填）
 */
public record WorkspaceCommand(
        Long id,
        String name,
        String type,
        String workDir,
        String containerId
) {
}

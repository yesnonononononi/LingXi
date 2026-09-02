package com.summit.dp.workspace.api.dto;

/**
 * 工作空间接口入参（add/update 共用，字段语义同 {@code WorkspaceCommand}）。
 */
public record WorkspaceRequest(
        Long id,
        String name,
        String type,
        String workDir,
        String containerId
) {
}

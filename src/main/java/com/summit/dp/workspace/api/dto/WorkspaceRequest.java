package com.summit.dp.workspace.api.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** 工作空间接口入参（仅新增；字段语义同 {@code WorkspaceCommand}）。 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record WorkspaceRequest(
        String name,
        String hostDir
) {
}

package com.summit.dp.workspace.application.command;

/** 工作空间应用命令（仅用于新增；工作空间创建后不可变更）。 */
public record WorkspaceCommand(
        String name,
        String hostDir
) {
}

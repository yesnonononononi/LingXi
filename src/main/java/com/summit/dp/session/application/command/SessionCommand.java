package com.summit.dp.session.application.command;

/**
 * 会话应用命令。
 *
 * @param id          更新时必填；新增时忽略
 * @param name        会话名称，可空（新增时默认“新对话”）
 * @param workspaceId 绑定的工作空间 id，仅新增时使用（可空 = 不绑定），更新时忽略
 */
public record SessionCommand(Long id, String name, Long workspaceId) {
}

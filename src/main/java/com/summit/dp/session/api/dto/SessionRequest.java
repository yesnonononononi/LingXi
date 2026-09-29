package com.summit.dp.session.api.dto;

/**
 * 会话接口入参（字段语义同 {@code SessionCommand}）。
 *
 * <p>{@code agentId} 已移除：Agent 身份现由单例设置承载，不再随会话创建传入。</p>
 */
public record SessionRequest(
        Long id,
        String name,
        Long workspaceId
) {
}

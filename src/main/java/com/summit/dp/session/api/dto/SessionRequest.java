package com.summit.dp.session.api.dto;

/**
 * 会话接口入参（字段语义同 {@code SessionCommand}）。
 */
public record SessionRequest(
        Long id,
        String name,
        Long workspaceId
) {
}

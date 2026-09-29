package com.summit.dp.session.application.command;

/**
 * 会话应用命令。
 *
 * <p>字段一律「null 表示本次不改」：应用层按 {@code if (command.getXxx() != null)} 逐字段
 * 驱动领域方法，未传的字段保持库中原值。因此 {@code teamId} 无法通过本命令表达「解绑到 null」，
 * 解绑走 {@code SessionService#bindTeam}（团队选择的下拉框清空即解绑）。</p>
 */
public record SessionCommand(Long id, String name, Long teamId) {
}

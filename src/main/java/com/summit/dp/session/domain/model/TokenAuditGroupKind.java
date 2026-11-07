package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

/**
 * 工具来源分组：下钻第一层。
 *
 * <p>MCP / Skill 是框架给出的**聚合值**，本轮不再向「按 server」下钻（框架未提供该维度）；
 * 普通工具才按工具名出明细行。声明顺序即展示顺序，也是 sort_order 的生成顺序。</p>
 */
public enum TokenAuditGroupKind {

    /** MCP 远端工具调用。 */
    MCP,
    /** Skill 工具调用。 */
    SKILL,
    /** 内置（普通）工具调用，唯一有工具名明细的分组。 */
    ORDINARY;

    /**
     * 按持久化名还原枚举；空值返回 {@code null}（消息类行的 group_kind 本来就是 NULL）。
     *
     * @param name 持久化名，不区分大小写；允许 null / blank
     * @return 对应枚举或 {@code null}
     * @throws ClientException 名字非空且不在枚举内
     */
    public static TokenAuditGroupKind fromName(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        for (TokenAuditGroupKind kind : values()) {
            if (kind.name().equalsIgnoreCase(name.strip())) {
                return kind;
            }
        }
        throw new ClientException("无法识别的 token 审计工具分组: " + name);
    }
}

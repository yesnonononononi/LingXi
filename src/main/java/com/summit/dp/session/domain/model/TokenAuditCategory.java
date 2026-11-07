package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

/**
 * 消息构成的四类分项。
 *
 * <p>与框架 {@code MessageType} 同名对齐，但**不带任何框架依赖**：
 * domain 层不得出现 {@code com.summit.core.*} 类型（Session 类注释的既定约束）。</p>
 *
 * <p>{@code TOOL} 一行的 token 是**去重叠后**的结果值（参数已计入 {@code AI}，
 * 见 {@link SessionTokenAuditItem#resultTokens()}），这是本次设计的核心口径。</p>
 */
public enum TokenAuditCategory {

    /** 系统提示词。 */
    SYSTEM,
    /** 用户消息。 */
    USER,
    /** 模型消息：含工具调用参数，故参数不再重复计入 TOOL。 */
    AI,
    /** 工具结果消息（去重叠口径）。 */
    TOOL;

    /**
     * 按持久化名还原枚举（PO 里存的是 {@link #name()}）。
     *
     * @param name 持久化名，不区分大小写
     * @return 对应枚举
     * @throws ClientException 名字为空或不在枚举内
     */
    public static TokenAuditCategory fromName(String name) {
        if (name == null || name.isBlank()) {
            throw new ClientException("token 审计分类不能为空");
        }
        for (TokenAuditCategory category : values()) {
            if (category.name().equalsIgnoreCase(name.strip())) {
                return category;
            }
        }
        throw new ClientException("无法识别的 token 审计分类: " + name);
    }
}

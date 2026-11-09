package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

/** 会话审计的消息与附件分项。 */
public enum TokenAuditCategory {

    /** 系统提示词。 */
    SYSTEM,
    /** 用户消息。 */
    USER,
    /** 模型消息。 */
    AI,
    /** 工具调用参数与结果消息。 */
    TOOL,
    /** 用户消息中的非文本附件。 */
    ATTACHMENT;

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

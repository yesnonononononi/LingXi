package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

/**
 * 明细行的层级：一条明细是「消息四类」「工具分组」还是「工具名」。
 *
 * <p>存库用 {@link #code()}（TINYINT），读库用 {@link #fromCode(int)}。
 * 两侧必须对称升级：漏了 fromCode 的兜底就是启动期空指针。</p>
 */
public enum TokenAuditItemLevel {

    /** 消息构成四类，固定 4 行。 */
    MESSAGE(1),
    /** 工具分组（MCP / SKILL / ORDINARY）。 */
    TOOL_GROUP(2),
    /** 单个普通工具（按工具名聚合）。 */
    TOOL_ITEM(3);

    private final int code;

    TokenAuditItemLevel(int code) {
        this.code = code;
    }

    /** 持久化编码。 */
    public int code() {
        return code;
    }

    /**
     * 按持久化编码还原层级。
     *
     * @param code 库里的 item_level
     * @return 对应枚举
     * @throws ClientException 编码未知（说明 DDL 与领域枚举不同步）
     */
    public static TokenAuditItemLevel fromCode(Integer code) {
        if (code == null) {
            throw new ClientException("token 审计明细层级不能为空");
        }
        for (TokenAuditItemLevel level : values()) {
            if (level.code == code) {
                return level;
            }
        }
        throw new ClientException("无法识别的 token 审计明细层级: " + code);
    }
}

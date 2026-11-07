package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 会话级 token 审计的明细行：消息四类、工具分组、普通工具名各占一行。
 *
 * <p>为什么工具名是「值」而不是「列」：工具集合随 MCP / Skill / 内置工具增减而变化，
 * 写成列就要改 DDL；写成 JSON CLOB 又失去 SQL 侧可求和、可校验的能力。</p>
 *
 * <p>为什么用 {@link IdType#AUTO}：每次采集都是「删旧行 + 插新行」，
 * 明细行不需要跨实例唯一的业务标识。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("session_token_audit_item")
public class SessionTokenAuditItemPO {

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sessionId;
    /** 1 = 消息类、2 = 工具分组、3 = 普通工具明细（与 {@code TokenAuditItemLevel.code()} 对齐）。 */
    private Integer itemLevel;
    /** {@code SYSTEM} / {@code USER} / {@code AI} / {@code TOOL}。 */
    private String category;
    /** {@code MCP} / {@code SKILL} / {@code ORDINARY}；消息类行为 null。 */
    private String groupKind;
    /** 普通工具明细行才有值；分组行与消息行均为 null。 */
    private String toolName;
    private Integer callCount;
    /** 框架原值（含工具调用参数），展示去重叠由领域层 {@code resultTokens()} 计算。 */
    private Integer totalTokens;
    private Integer argumentTokens;
    private Integer outputTokens;
    private Integer sortOrder;
}

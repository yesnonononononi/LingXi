package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

import java.util.List;

/** 工具分组（MCP / SKILL / ORDINARY）：分组总量 + 「N 项」徽标 + 普通工具的工具名明细。 */
@Data
@Builder
public class TokenAuditToolGroupVO {

    /** {@code MCP} / {@code SKILL} / {@code ORDINARY}。 */
    private String groupKind;
    /** 分组展示值（框架已去重叠，直接取框架总量 / Σ工具名）。 */
    private Integer tokens;
    /** 占父级（TOOL 总量）的比例；父级为 0 或缺失时 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
    /** 调用条数；框架审计文档不携带条数时如实为 0（不凭空造数）。 */
    private Integer callCount;
    /** 工具名明细：仅 {@code ORDINARY} 非空，按展示值降序（同值按名字升序）。 */
    private List<TokenAuditToolItemVO> items;
}

package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;


/** 工具分组（MCP / SKILL / ORDINARY）：分组总量 + 普通工具的工具名明细。 */
@Data
@Builder
public class TokenAuditToolGroupVO {

    /** {@code MCP} / {@code SKILL} / {@code ORDINARY}。 */
    private String groupKind;
    /** 框架分组计数；普通工具没有组汇总。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer tokens;
    /** 框架原始比例，不以 TOOL 总量重算。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
}

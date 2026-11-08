package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/** TOOL 下钻顶层：总计 + 三个分组（MCP / SKILL / ORDINARY），未出现的分组为 null。 */
@Data
@Builder
public class TokenAuditToolBreakdownVO {

    /** 框架工具计数，与 TOOL 消息行同源，不要求等于各分组之和。 */
    private Integer tokens;
    /** 框架原始比例。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
    /** MCP 工具分组；本轮没有 MCP 调用时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditToolGroupVO mcp;
    /** Skill 工具分组；本轮没有 Skill 调用时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditToolGroupVO skill;
    /** 普通工具分组；本轮没有普通工具调用时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOrdinaryToolsVO ordinary;
}

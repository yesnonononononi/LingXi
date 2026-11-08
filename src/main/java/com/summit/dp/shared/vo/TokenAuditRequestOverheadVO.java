package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/** 框架工具定义明细，不增加合计、父级比例或残差。 */
@Data
@Builder
public class TokenAuditRequestOverheadVO {
    private Integer itemCount;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO toolDefinition;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO mcpToolDefinition;
}

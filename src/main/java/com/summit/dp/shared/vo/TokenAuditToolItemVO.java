package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/** 单个普通工具（按工具名聚合）的展示值。 */
@Data
@Builder
public class TokenAuditToolItemVO {

    /** 工具名；框架无法归名时为 {@code unknown_tool}。 */
    private String toolName;
    /** 展示值（框架已去重叠，不含工具调用参数）。 */
    private Integer tokens;
    /** 工具调用参数 token：已计入 AI 项，只读说明，不参与任何求和。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer argumentTokens;
    /** 工具输出文本 token。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer outputTokens;
}

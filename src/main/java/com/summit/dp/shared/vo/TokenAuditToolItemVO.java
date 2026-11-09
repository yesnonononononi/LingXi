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
    /** 框架明细总量，含调用参数。 */
    private Integer tokens;
    /** 工具调用参数 token，已计入本项总量。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer argumentTokens;
    /** 工具输出文本 token。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer outputTokens;
}

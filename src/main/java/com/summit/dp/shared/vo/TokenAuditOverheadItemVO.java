package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/** 框架给出的定义计数和比例，不按业务父级归一。 */
@Data
@Builder
public class TokenAuditOverheadItemVO {

    /** 子项 token 数。 */
    private Integer tokens;
    /** 框架原始比例。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
}

package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

/** 消息或附件的框架审计分项。 */
@Data
@Builder
public class TokenAuditCategoryVO {

    /** 分类名，取值与 {@code TokenAuditCategory} 一致。 */
    private String type;
    /** 框架分项计数，工具分项含调用参数和结果消息。 */
    private Integer tokens;
    /** 框架原始比例，不以消息总量重算。 */
    private Double ratio;
    /** 是否可展开下钻：仅 {@code TOOL} 为 true。 */
    private boolean expandable;
}

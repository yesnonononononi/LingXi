package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

/** 四类消息分项（{@code SYSTEM} / {@code USER} / {@code AI} / {@code TOOL}）。 */
@Data
@Builder
public class TokenAuditCategoryVO {

    /** 分类名，取值与 {@code TokenAuditCategory} 一致。 */
    private String type;
    /** 该类 token；TOOL 行为框架去重叠后的结果值（不含工具调用参数）。 */
    private Integer tokens;
    /** 框架原始比例，不以消息总量重算。 */
    private Double ratio;
    /** 是否可展开下钻：仅 {@code TOOL} 为 true。 */
    private boolean expandable;
}

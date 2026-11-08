package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 「工具定义构成」下的单个子项：{@code { tokens, ratio }}。
 *
 * <p>对应设计稿「其他消息 → 工具定义构成」里的「内核工具定义 / MCP工具定义」两行。
 * {@code ratio} 的分母是<b>父项「其他消息」自身</b>（例如 10,400 / 15,200 = 68.4%），
 * 不是 messagesTotalTokens —— 设计稿已按此口径标注，父项的两个子项恰好加总为父项、无残差行。</p>
 *
 * <p><b>子项不存在时整个对象不下发</b>（框架未给出该项审计）：
 * {@code null} 是「不知道」，0 会画出「工具定义零开销」的假柱子。</p>
 */
@Data
@Builder
public class TokenAuditOverheadItemVO {

    /** 子项 token 数。 */
    private Integer tokens;
    /** {@code tokens / 父项 tokens}；父项缺失或 {@code <= 0} 时为 null（不除零）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
}

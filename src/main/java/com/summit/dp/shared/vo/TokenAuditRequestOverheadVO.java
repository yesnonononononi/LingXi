package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 设计稿的「其他消息」面板：非消息请求开销的构成（工具定义 + MCP 工具定义 + 请求框架残差）。
 *
 * <p><b>它<b>不属于</b>{@code messages} 数组</b>：{@code messages} 的四类求和必须恰等于
 * {@code messagesTotalTokens}（12,400+18,920+38,450+73,080 = 142,850），
 * 而这一块是「总量比四类之和多出来的部分」，混进去会直接破坏那条恒等式。</p>
 *
 * <p><b>占比分母是 {@code messagesTotalTokens}</b>（15,200 / 142,850 = 10.64% → 10.6%），
 * 不是 {@code totalTokens}；后者会得到 10.3%，与设计稿标注不符。
 * 这与「其他消息」在视觉上与四类并排、语义上却属于「额外部分」是一致的。</p>
 *
 * <p><b>本对象与 {@code reconciliation} 里的同名数值同源</b>：都直接取自快照的落库列，
 * 由查询服务一次性传入，不在两处各算一遍，避免出现「对账区说 8,200、展示区说 8,100」。</p>
 */
@Data
@Builder
public class TokenAuditRequestOverheadVO {

    /** 非消息请求开销 = 工具定义 + MCP 工具定义 + 请求框架残差。 */
    private Integer tokens;
    /** {@code tokens / messagesTotalTokens}；父级缺失或 {@code <= 0} 时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
    /**
     * 实际有值的子项个数（设计稿的「[2 项]」）：
     * 只数非 null 的 {@link #toolDefinition} / {@link #mcpToolDefinition}，
     * <b>不把残差行算进去</b>（它是派生行，不是一项独立开销）。
     */
    private Integer itemCount;
    /** 内核（非 MCP）工具定义；框架未给出时为 null，此时整个子项不下发。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO toolDefinition;
    /** MCP 工具定义；框架未给出时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO mcpToolDefinition;
    /**
     * 请求框架残差：{@code tokens − 内核 − MCP}（派生，不落库）。
     *
     * <p>设计稿没有这一行只因为示例数字恰好为 0；前端按「非 0 才渲染第三行」处理。
     * 后端必须<b>如实给出</b>：把它并进内核或 MCP 里抹平，就等于篡改归因。
     * 两项工具定义任一为 null 时整体为 null（不拿部分已知去凑）。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer framingResidualTokens;
}

package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 「其他消息」（请求开销）小节。
 *
 * <p><b>父项金额必须下发</b>：{@code tokens} 是 {@code total − Σ messages}（域里已落库），
 * 不下发就会出现「有 N 项徽标、没有金额」的幽灵行 —— 用户无法闭合消息构成。</p>
 *
 * <p><b>恒等式</b>：{@code tokens = toolDefinition + mcpToolDefinition + framingResidualTokens}。
 * 三项里任一项未知时为 {@code null}（未知），绝不用 0 顶替。</p>
 */
@Data
@Builder
public class TokenAuditRequestOverheadVO {

    /** 其他消息总量（= 快照总量 − 消息构成合计）；null 表示未知。 */
    private Integer tokens;
    /** 占上下文上限的比例，与框架分项同分母；null 表示未知。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double ratio;
    /** 工具定义子项个数（内核 + MCP），供「N 项」徽标；残差是派生行，不计入。 */
    private Integer itemCount;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO toolDefinition;
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditOverheadItemVO mcpToolDefinition;
    /**
     * 请求框架残差（合并计数与分开计数的分词差异，<b>可为负</b>）。
     *
     * <p>前端把它展示成「其它」并附说明，不再暴露「框架残差」这类内部术语。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer framingResidualTokens;
}

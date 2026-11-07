package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 差额解释：{@code totalTokens} 与四类分项之间的三个差额，一次讲清「多出来的 token 是什么」。
 *
 * <p>前端不需要做任何减法，所有差额都由后端算好 —— 口径只能有一个实现点。</p>
 */
@Data
@Builder
public class TokenAuditReconciliationVO {

    /** 快照总量 = {@code messagesTokens + requestOverheadTokens}。 */
    private Integer totalTokens;
    /** 四类分项之和。 */
    private Integer messagesTokens;
    /**
     * 非消息请求开销：工具定义（名称 / 描述 / schema）+ 请求框架，
     * 扣除各分项独立测量时重复计入的 primer。正常为正，无工具注册时可能为 {@code −9} 量级。
     */
    private Integer requestOverheadTokens;
    /** 工具调用参数 token：已计入 AI 项，仅说明，不参与任何求和。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer argumentOverlapTokens;
    /**
     * 诊断值，<b>前端默认不渲染</b>：框架自报工具总量 − 各分组展示值之和（有符号）。
     *
     * <p>它是归因漂移的绊线：分组归因一旦写错（例如某工具被重复计入 5000），这里会先变大，
     * 而 {@code requestOverheadTokens} 不响。该值由采集瞬间算出并落库（{@code tool_grouping_drift}），
     * 因为恒等式 3 要求 TOOL 行 = Σ分组，读库派生恒为 0、没有诊断意义。
     * 常态为负（每个分组独立测量各带一个 primer），不影响任何恒等式，也不参与前端求和。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer toolGroupingDrift;
}

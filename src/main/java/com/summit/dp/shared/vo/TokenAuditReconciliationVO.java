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
    /**
     * 随请求下发的工具定义 token（名称 / 描述 / schema）。
     *
     * <p><b>属于非消息请求开销</b>：它和消息一起占上下文，但不属于 SYSTEM/USER/AI/TOOL 任何一类
     * —— 这正是「总量比四类之和多出来」的那部分。缺省（{@code null}）表示框架未给出该项审计，
     * 前端应整块隐藏而不是显示 0。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer toolDefinitionTokens;
    /** 随请求下发的 MCP 工具定义 token；属于非消息请求开销，{@code null} 表示未知。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer mcpToolDefinitionTokens;
    /**
     * 请求框架残差（派生值，<b>不落库</b>）：{@code requestOverheadTokens − toolDefinitionTokens
     * − mcpToolDefinitionTokens}。即「非消息请求开销里扣掉两项工具定义后剩下的框架成本」
     * （角色标记、分隔符、primer 等）。可负：与请求开销同源，扣不干净时就是负的。
     * 两项工具定义任一未知时为 {@code null}（不拿部分已知去凑一个残差值）。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer framingResidualTokens;
}

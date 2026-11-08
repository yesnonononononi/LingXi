package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.List;

/**
 * 会话级 token 审计视图（侧边栏「上下文构成」唯一数据源）。
 *
 * <p>与 SSE 事件 {@code token_audit_snapshot} 的 payload 同构：
 * 前端首次打开走 {@code GET /session/{id}/token-audit}，之后靠推送整体刷新，无需两套解析。</p>
 *
 * <p><b>{@code displayState} 是后端唯一判据</b>：前端不再自行比较「快照总量 vs 实时总量」，
 * 否则两边的容差规则迟早漂移。</p>
 *
 * <p>可空字段一律 {@link JsonInclude.Include#NON_NULL}：{@code null} 语义是「不知道」，
 * 与 0 的区别必须能被前端区分（0 会画出误导性的构成图）。</p>
 */
@Data
@Builder
public class SessionTokenAuditVO {

    /** 雪花 ID 按字符串下发：超出 JS 安全整数范围，数值会被前端精度截断。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long sessionId;
    /** {@code NOT_COLLECTED} / {@code CAPTURING} / {@code COLLECTED} / {@code FAILED}，恒有值。 */
    private String displayState;
    /**
     * 实时已用 token（{@code Session.contextTokenCount}）；null 表示尚未采集。
     *
     * <p><b>类型必须是 {@link Integer}，不能是 {@code Long}</b>：本工程的 Jackson 全局把
     * {@code Long} 序列化成<b>字符串</b>（雪花 ID 超 JS 安全整数，必须字符串）。但 token 数量
     * 永远达不到 int 上限，用 {@code Long} 会连同「ID 必须字符串」这条规则一起被抄过来，
     * 于是同一个 VO 里出现 `"148200"`（字符串）与 `148200`（数值）两种 JSON 类型 ——
     * 前端按 number 解析，字符串那一路会被当成「未知」整行不渲染。
     * 同语义同类型是本类的硬约束：<b>token 计数一律 {@code Integer}，只有 ID 才是 {@code Long}。</b></p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer liveTotalTokens;
    /** 实时上下文上限；null 表示未知。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer liveMaxTokens;
    /** {@code liveTotalTokens / liveMaxTokens}，可 &gt; 1；上限未知时为 null（不除零）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double liveRatio;
    /**
     * 剩余可用 token = {@code liveMaxTokens − liveTotalTokens}（设计稿「剩余可用 51,800 tok」）。
     *
     * <p>任一为 null 则整体为 null：把「上限未知」当成「剩余 0」会让进度条显示成已占满。</p>
     *
     * <p><b>类型与 {@link #liveTotalTokens} 保持一致（{@link Integer}）</b>：两者是同一语义量
     * 「token 数量」的变形，若一个 Integer 一个 Long，同一条 JSON 里又会一个数值一个字符串。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer remainingTokens;
    /** {@code remainingTokens / liveMaxTokens}；上限未知或 {@code <= 0} 时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double remainingRatio;
    /** 快照总量（框架口径：消息 + 工具定义 + 请求框架）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer totalTokens;
    /** {@code liveTotalTokens − totalTokens}；仅 {@code CAPTURING} 有意义。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer driftTokens;
    /** 采集时刻（ISO 8601 UTC）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Instant capturedAt;
    /** 仅 {@code FAILED} 有值（中文业务文案）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private String failReason;
    /** 差额解释；{@code NOT_COLLECTED} 时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditReconciliationVO reconciliation;
    /**
     * 设计稿的「其他消息」面板：非消息请求开销的工具定义构成。
     *
     * <p><b>刻意不放进 {@link #messages}</b>：四类分项之和必须恰等于
     * {@link #messagesTotalTokens}，而这块是「总量比四类之和多出来」的部分，
     * 混进数组会让那条恒等式不成立（设计稿也用 {@code border-t} 把它单独隔开）。</p>
     *
     * <p>无快照或总量未知时为 null（此时谈不上「构成」）。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditRequestOverheadVO requestOverhead;
    /** 四类分项：恒为 4 条、固定顺序 SYSTEM / USER / AI / TOOL。 */
    private List<TokenAuditCategoryVO> messages;
    /** 四类之和（= {@code reconciliation.messagesTokens}）；无快照时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer messagesTotalTokens;
    /** TOOL 下钻；无工具分组时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditToolBreakdownVO tools;
}

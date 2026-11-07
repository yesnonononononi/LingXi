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
    /** 实时总量（{@code Session.contextTokenCount}）；null 表示尚未采集。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Long liveTotalTokens;
    /** 实时上下文上限；null 表示未知。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer liveMaxTokens;
    /** {@code liveTotalTokens / liveMaxTokens}，可 &gt; 1；上限未知时为 null（不除零）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Double liveRatio;
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
    /** 四类分项：恒为 4 条、固定顺序 SYSTEM / USER / AI / TOOL。 */
    private List<TokenAuditCategoryVO> messages;
    /** 四类之和（= {@code reconciliation.messagesTokens}）；无快照时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer messagesTotalTokens;
    /** TOOL 下钻；无工具分组时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private TokenAuditToolBreakdownVO tools;
}

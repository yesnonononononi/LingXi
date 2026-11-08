package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 会话级 token 审计快照（头表）：一个会话只保留最近一次采集，主键即会话 id。
 *
 * <p>为什么用 {@link IdType#INPUT}：主键是业务键（session_id），不是自增序列；
 * 与 {@code session_context} 表同一先例，upsert 语义天然成立。</p>
 *
 * <p>为什么数值列都可空：{@code audit_state = FAILED} 时只保留失败原因与时间，
 * 用 0 冒充「采集到 0 token」会让前端画出错误的构成图。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("session_token_audit")
public class SessionTokenAuditPO {

    @TableId(type = IdType.INPUT)
    private Long sessionId;
    /** 产出这份快照的执行；归属解析失败时为 null（此时只落库、不广播）。 */
    private Long executionId;
    /** {@code COLLECTED} / {@code FAILED}：持久层只承认这两种事实。 */
    private String auditState;
    private Integer totalTokens;
    private Integer maxTokens;
    private Integer messagesTokens;
    private Integer requestOverheadTokens;
    private Integer overlapTokens;
    /**
     * 归因漂移（有符号）：框架自报工具总量 − 各分组展示值之和。
     * 只作诊断，不进 {@code request_overhead_tokens}，也不参与任何恒等式求和。
     */
    private Integer toolGroupingDrift;
    /**
     * 随请求下发的工具定义 token（框架 {@code e9c6ec6}）。null 表示「未知」，
     * 不是 0 —— 0 会让前端画出「工具定义零开销」的假柱子。
     */
    private Integer toolDefinitionTokens;
    /** 随请求下发的 MCP 工具定义 token；null 表示未知。 */
    private Integer mcpToolDefinitionTokens;
    private Instant capturedAt;
    private String failReason;
    private Instant createTime;
    private Instant updateTime;
}

package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.List;

/**
 * 会话消息视图对象：把落库内容按类型摊平，前端无需再解析 JSON 字符串。
 *
 * <p>卡片（工具调用）数据不再内联：TOOL 行的 {@code toolCallId} 指向 `tool_call` 行，
 * 由 {@link #toolCall} 承载完整聚合视图；AI 行的 {@link #toolCalls} 只是「模型请求了什么」的
 * 请求视图，**不是结果来源**。</p>
 *
 * <p><b>{@link #turnId} 是回答分组的唯一键（2026-09-30）：</b>前端按它把同一轮的
 * USER / AI / TOOL / ERROR 归到一组，并到 {@link SessionMessagePageVO#getTurns()}
 * 里取该组的轮次信息。{@code null} 表示归属未知（本次改造之前的旧数据），前端降级展示。</p>
 *
 * <p><b>刻意不下发 {@code executionId}</b>：框架执行 ID 是运行时概念，业务侧对外的归属
 * 一律用业务轮次 ID。消息行内部仍以 {@code execution_id} 关联轮次，但那只是服务端装配时的
 * 连接键，不是契约的一部分。</p>
 */
@Data
@Builder
public class SessionMessageVO {

    @JsonSerialize(using = ToStringSerializer.class)
    private Long id;
    private Long sessionId;

    /**
     * 该消息所属的**业务轮次** ID。JSON 中按字符串下发。
     *
     * <p>服务端在装配本页时按消息行的 {@code execution_id} 批量反查轮次得到；
     * {@code null} 表示本次改造之前的旧数据（或该执行没有对应轮次行），展示层降级，
     * 不按位置或时间戳猜一个归属出来。</p>
     */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long turnId;
    /** 消息类型：USER / AI / TOOL / SYSTEM / ERROR */
    private String type;
    /** USER、SYSTEM、ERROR 的正文；AI 的回复正文 */
    private String text;
    /** AI 的思维链 */
    private String thinking;
    /** AI 发起的工具调用（模型请求视图，非结果来源） */
    private List<ModelToolCallVO> toolCalls;
    /** TOOL：回指的调用 id（= AI 消息 toolCalls[].id / 模型下发的 call id） */
    private String toolCallId;
    /** TOOL：聚合工具调用（含 type/status/title/content/rawInput/rawOutput/metaData/pending）；缺行时为 null */
    private ToolCallVO toolCall;
    private Instant createTime;
}

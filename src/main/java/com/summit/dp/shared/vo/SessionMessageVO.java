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
 * <p><b>{@link #executionId} 是回答分组的稳定键（2026-09-30）：</b>前端按它把同一轮的
 * USER / AI / TOOL / ERROR 归到一组，并到 {@link SessionMessagePageVO#getExecutions()}
 * 里取该组的执行摘要。{@code null} 表示归属未知（本次改造之前的旧数据），前端降级展示。</p>
 */
@Data
@Builder
public class SessionMessageVO {

    @JsonSerialize(using = ToStringSerializer.class)
    private Long id;
    /** 产生该消息的执行 ID；null 表示归属未知（旧数据）。JSON 中按字符串下发。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long executionId;
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

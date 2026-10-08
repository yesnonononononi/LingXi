package com.summit.dp.session.domain.model;



import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
import java.util.UUID;

@Builder
@Getter
public class SessionMessage {
    private final Long id;

    /**
     * 本轮模型调用的响应身份，由框架生成并下发（{@code ChatResponseEntity.responseId}）。
     *
     * <p><b>只挂在 AI 行上</b>：一轮里多个工具行共享同一身份，若都存会撞
     * {@code (session_id, response_id)} 唯一索引；幂等以轮为单位，工具行不必各存一份。</p>
     *
     * <p>{@code null} 表示框架未下发身份（异常构造的执行、旧数据），此时不参与幂等拦截。</p>
     */
    private final UUID responseId;

    private final Long sessionId;
    /**
     * 这条消息所属的**业务轮次** ID（关联 {@code chat_turn.id}）。
     *
     * <p>它是「回答分组」与「元信息归属」的唯一键：前端按它把 USER / AI / TOOL / ERROR
     * 归到同一轮，并把轮次信息挂到组上。{@code null} 表示归属未知 —— 只出现在本次改造
     * 之前落库的旧数据上（或该执行没有对应轮次行），展示层据此降级，
     * **不按消息位置或时间戳猜测**。</p>
     *
     * <p><b>业务侧只有这一个归属概念</b>：框架执行 ID 仅存在于
     * {@code chat_turn.execution_id}（接收框架生命周期信号）与 {@code tool_call.execution_id}
     * （定位工具调用）这两个「与框架交互」的边界上，不进入消息归属。</p>
     */
    private final Long turnId;
    /**
     * 本轮模型调用在一轮内的序号（0 基），只挂在 AI 行。
     *
     * <p>Block 装配的「响应顺序」这一层靠它：同一轮里模型可以多轮
     * 「思考 → 调工具 → 再思考」，若干 AI 行共享同一 {@code turnId}；没有它就只剩
     * 消息主键（插入顺序）可排，而插入顺序与模型调用顺序在并发/补写场景下不等价。</p>
     *
     * <p>{@code null} 表示序号未知（本次改造之前落库的 AI 行），展示层按未知降级，
     * **不补一个 0** —— 补 0 会让旧行全排到新一轮前面。</p>
     */
    private final Integer responseOrder;
    private final SessionMessageType type;
    private String text;
    private final Instant createTime;

}

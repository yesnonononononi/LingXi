package com.summit.dp.turn.application.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import com.summit.dp.shared.config.PlainLongSerializer;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * 业务轮次视图：历史接口按 {@code turnId} 下发，前端按它组织回答组。
 *
 * <p><b>与框架 {@code execution} 的关系</b>：本视图读的是业务 {@code chat_turn} 表
 * （业务上最权威的单次请求记录），不暴露框架执行 ID —— 执行 ID 是运行时概念，
 * 业务侧对外一律用轮次 ID。</p>
 *
 * <p><b>口径</b>：{@code status} 是业务状态（ACCEPTED/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED），
 * 其中 WAITING 对应框架 SUSPENDED。token 与 {@code elapsedMs} 为 {@code null} 时表示未知
 * —— 与 0 严格区分，界面应显示「暂无统计」而不是 0。{@code elapsedMs} 是
 * {@code startedAt} →（{@code completedAt} 或查询时刻），**包含暂停与等待审批的时间**。</p>
 */
@Data
@Builder
public class ChatTurnVO {

    /** 轮次 ID（雪花）：JSON 中按字符串下发，避免前端精度丢失。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long turnId;
    private Long version;


    /** 发起本次子 Agent 委派的主轮次；普通用户提问为 null。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long parentTurnId;

    /** ACCEPTED | RUNNING | WAITING(=框架 SUSPENDED) | COMPLETED | FAILED | CANCELLED。 */
    private String status;

    /** 本轮实际使用的模型名称快照；null 表示未解析出。 */
    private String modelName;

    /** 模型提供方快照。 */
    private String modelProvider;

    /** 本轮已采集输入 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long inputTokens;

    /** 本轮已采集输出 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long outputTokens;

    /** 本轮已采集总 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long totalTokens;

    /** 首次开始执行时间（框架 onStart 时刻）；未真正开始为 null。 */
    private Instant startedAt;

    /** 进入终态的时间；未结束为 null。 */
    private Instant completedAt;

    /**
     * 面向用户的失败原因；仅 {@code status == 'FAILED'} 时有意义。
     *
     * <p>失败不是一条消息，而是轮次的属性 —— 前端把它挂在**回答组**上渲染，
     * 不要在消息列表里生成独立气泡。</p>
     */
    private String errorReason;

    /** 已历时毫秒（含暂停与等待审批）；{@code startedAt} 为空时为 null。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long elapsedMs;
}

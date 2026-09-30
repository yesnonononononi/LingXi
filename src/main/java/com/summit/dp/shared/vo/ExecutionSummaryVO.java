package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import com.summit.dp.shared.config.PlainLongSerializer;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * 一次执行的查询摘要：历史接口按 {@code executionId} 批量装配，挂在消息页的
 * {@code executions} 字典里下发。
 *
 * <p><b>为什么要有它：</b>token 用量、使用模型、耗时与状态此前只出现在一次性的
 * {@code EXECUTION_COMPLETED} 事件里，刷新或重新订阅后全部消失。摘要落库后，
 * 历史、实时、暂停恢复三条路径共用同一份口径。</p>
 *
 * <p><b>口径（首版）：</b></p>
 * <ul>
 *   <li>{@code inputTokens / outputTokens / totalTokens} 是**本执行已采集的累计值**
 *       （框架跨轮累加，每轮 input 都重算整段上下文，所以数值会明显大于上下文长度）。
 *       {@code null} = 未采集到，与 {@code 0} = 确实为 0 严格区分，前端据此显示「暂无统计」。</li>
 *   <li>{@code startedAt} 是首次开始时间，暂停恢复不重置；{@code completedAt} 仅在终态写入。</li>
 *   <li>{@code elapsedMs} = {@code startedAt} →（{@code completedAt} 或查询时刻），
 *       <b>包含暂停与等待审批的时间</b>。进行中时它是「截至本次查询」的已历时，
 *       不是最终值 —— 界面必须说明「总历时含等待时间」。</li>
 * </ul>
 */
@Data
@Builder
public class ExecutionSummaryVO {

    /** 执行 ID（雪花）：JSON 中按字符串下发，避免前端精度丢失。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long executionId;

    /** 执行状态：CREATED | RUNNING | SUSPENDED | COMPLETED | FAILED | CANCELLED。 */
    private String status;

    /** 执行开始时实际解析出的模型名称快照；历史执行不随当前模型配置变化。 */
    private String modelName;

    /** 模型提供方快照。 */
    private String modelProvider;

    /** 本执行累计已采集输入 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long inputTokens;

    /** 本执行累计已采集输出 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long outputTokens;

    /** 本执行累计已采集总 token；null = 未知。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long totalTokens;

    /** 执行首次开始时间；未开始为 null。 */
    private Instant startedAt;

    /** 进入完成 / 失败 / 取消终态的时间；未结束为 null。 */
    private Instant completedAt;

    /** 已历时毫秒（含暂停与等待审批）；{@code startedAt} 为空时为 null。 */
    @JsonSerialize(using = PlainLongSerializer.class)
    private Long elapsedMs;
}

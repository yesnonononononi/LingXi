package com.summit.dp.execution.domain.model;

import lombok.Data;
import java.time.LocalDateTime;

/**
 * 执行领域模型。
 *
 * <p>请求参数与执行元状态由 snapshot 承载；本地模式下 worker 归属、租约与控制指令
 * 由框架进程内注册表承担，不落库。</p>
 *
 * <p>摘要字段（rootExecutionId / modelName / modelProvider / 三列 token / startedAt / completedAt）
 * 是查询用的冗余列：只由 {@code findSummariesByIds} 这类**不含 snapshot 的投影查询**填充，
 * 供历史接口按执行装配本轮统计。token 三列 {@code null} = 未知，{@code 0} = 确实为 0。</p>
 */
@Data
public class Execution {
    private Long id;
    private Long sessionId;
    /** 所属根执行 ID；主执行为 null，子执行指向发起委派的主执行。 */
    private Long rootExecutionId;
    /** 执行开始时实际解析出的模型名称快照。 */
    private String modelName;
    /** 执行开始时实际解析出的模型提供方快照。 */
    private String modelProvider;
    /** 本执行累计已采集输入 token；null = 未知。 */
    private Long inputTokenCount;
    /** 本执行累计已采集输出 token；null = 未知。 */
    private Long outputTokenCount;
    /** 本执行累计已采集总 token；null = 未知。 */
    private Long totalTokenCount;
    /** 执行首次开始时间；暂停恢复不重置。 */
    private LocalDateTime startedAt;
    /** 进入终态的时间；未结束为 null。 */
    private LocalDateTime completedAt;
    private Integer status;
    private String snapshot;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

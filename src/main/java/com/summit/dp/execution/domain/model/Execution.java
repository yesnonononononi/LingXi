package com.summit.dp.execution.domain.model;

import lombok.Data;
import java.time.LocalDateTime;

/**
 * 执行领域模型。
 *
 * <p>请求参数与执行元状态由 snapshot 承载；本地模式下 worker 归属、租约与控制指令
 * 由框架进程内注册表承担，不落库。</p>
 *
 * <p>摘要字段（rootExecutionId / startedAt / completedAt）是查询用的冗余列：
 * 只由 {@code findSummariesByIds} 这类**不含 snapshot 的投影查询**填充。
 * 模型与 token 不再是本表的列 —— 它们是业务事实，权威在 {@code chat_turn}。</p>
 */
@Data
public class Execution {
    private Long id;
    private Long sessionId;
    /** 所属根执行 ID；主执行为 null，子执行指向发起委派的主执行。 */
    private Long rootExecutionId;
    /** 执行首次开始时间；暂停恢复不重置。 */
    private LocalDateTime startedAt;
    /** 进入终态的时间；未结束为 null。 */
    private LocalDateTime completedAt;
    private Integer status;
    private String snapshot;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

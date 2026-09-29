package com.summit.dp.execution.domain.model;

import lombok.Data;
import java.time.LocalDateTime;

/**
 * 执行领域模型。
 *
 * <p>请求参数与执行元状态由 snapshot 承载；本地模式下 worker 归属、租约与控制指令
 * 由框架进程内注册表承担，不落库。</p>
 */
@Data
public class Execution {
    private Long id;
    private Long sessionId;
    private Integer status;
    private String snapshot;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

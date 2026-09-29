package com.summit.dp.execution.application.vo;

import lombok.Data;
import java.time.LocalDateTime;

@Data
public class ExecutionVO {
    private Long id;
    private Long sessionId;
    private Integer status;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}

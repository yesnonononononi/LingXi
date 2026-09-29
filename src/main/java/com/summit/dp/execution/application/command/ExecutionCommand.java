package com.summit.dp.execution.application.command;

import lombok.Data;
import java.time.LocalDateTime;

@Data
public class ExecutionCommand {
    private Long id;
    private Long workspaceId;
    private Long modelConfigId;
    private String systemPrompt;
    private String task;
    private String toolListJson;
    private String attrsJson;
    private Boolean allowOutWorkspace;
    private String modelProvider;
    private Long sessionId;
    private Long agentId;
    private Long rootExecutionId;
    private Integer status;
    private Integer desiredAction;
    private String workerId;
    private LocalDateTime leaseUntil;
    private Long version;
    private Integer maxSteps;
    private String snapshot;
    private String errorMessage;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private LocalDateTime startedAt;
    private LocalDateTime completedAt;
}

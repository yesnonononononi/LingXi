package com.summit.dp.task.application.vo;

import lombok.Data;

import java.time.Instant;

/** 输出与结果来自运行句柄或已落库终态，不推测进程状态。 */
@Data
public class TaskVO {
    private Long id;
    private Long sessionId;
    private Long turnId;
    private String command;
    private String status;
    private String output;
    private Integer exitCode;
    private boolean truncated;
    private Instant createAt;
    private Instant completeAt;
}

package com.summit.dp.task.application.vo;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** 输出与结果来自运行句柄或已落库终态，不推测进程状态。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TaskVO {
    private Long id;
    private Long sessionId;
    private Long turnId;
    private String command;
    private String intention;
    private String status;
    private String output;
    private Integer exitCode;
    private boolean truncated;
    private Instant createAt;
    private Instant completeAt;
}

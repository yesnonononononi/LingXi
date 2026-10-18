package com.summit.dp.task.application.command;

import lombok.Data;


/**
 * Task 应用层命令（生成骨架）
 * <p>骨架仅承载聚合标识，业务字段按需在生成后补充。</p>
 */
@Data
public class TaskCommand {
    private Long id;
    private Long sessionId;
    private Long turnId;
    private String command;
    private String output;
    private String status;
}

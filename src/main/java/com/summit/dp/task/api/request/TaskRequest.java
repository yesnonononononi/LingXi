package com.summit.dp.task.api.request;

import lombok.Data;


/**
 * Task 接口层入参（生成骨架）
 * <p>骨架仅承载聚合标识，业务字段按需在生成后补充。</p>
 */
@Data
public class TaskRequest {
    private Long id;
    private Long sessionId;
    private Long turnId;
    private String command;
    private String output;
    private String status;
}

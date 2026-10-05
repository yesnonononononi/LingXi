package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.List;

/** 工具调用的客户端视图；pending 仅表示未决，可操作性以 allowedActions 为准。 */
@Data
@Builder
public class ToolCallVO {

    private String id;
    private Long conversationId;
    private Long sessionMessageId;
    private Long executionId;
    private String toolName;
    /** PROMISE / EXECUTE */
    private String type;
    /** pending / in_progress / completed */
    private String status;
    private Long version;
    private List<String> allowedActions;
    private String unavailableReason;
    private String title;
    private JsonNode content;
    private JsonNode rawInput;
    private JsonNode rawOutput;
    private JsonNode metaData;
    /** 是否可审批：{@code type == PROMISE && status == pending}。 */
    private boolean pending;
    private Instant createdAt;
    private Instant updatedAt;
}

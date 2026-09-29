package com.summit.dp.shared.vo;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * 工具调用聚合视图：消息分页与单条查询统一下发的「完整工具调用对象」。
 *
 * <p>由 {@code tool_call} 行聚合而来，承载类型 / 状态 / 卡片载荷。
 * {@link #pending} 是前端唯一可审批判定（后端权威下发），等价于
 * {@code type == 'PROMISE' && status == 'pending'}。</p>
 *
 * <p>{@code content} / {@code rawInput} / {@code rawOutput} / {@code metaData}
 * 已是解析后的 JSON 对象，前端可直接使用；解析失败时为 {@code null}（降级为「状态不可用」）。</p>
 */
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

package com.summit.dp.email.application.vo;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.List;

/**
 * Email 视图对象。
 * <p>{@code messageVOList} 仅在 {@code findById} 单查路径装载（分页列表不装载，避免 N+1）；
 * 未装载时为 {@code null}。</p>
 * <p>路由字段与领域模型同名：{@code workflowExecutionId} 是协作轮次隔离键，
 * {@code recipientAgentId} 是收件 Agent；旧模型中的 {@code targetExecutionId} 已删除。</p>
 */
@Data
@Builder
public class EmailVO {
    private final Long id;
    private final Long workflowExecutionId;
    private final Long recipientAgentId;
    private final Long teamId;
    private List<EmailMessageVO> messageVOList;
    private Integer status;
    private final Instant createAt;
    private final Instant updateAt;
}

package com.summit.dp.email.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * Email 持久化对象，映射 {@code email} 表。
 * <p>主键为应用层生成的雪花 id（{@link IdType#INPUT}），不依赖数据库自增。
 * 业务键 {@code (workflow_execution_id, recipient_agent_id)} 上有唯一索引
 * {@code uk_email_workflow_recipient}，并发首次建箱由数据库裁决。</p>
 */
@Data
@TableName("email")
@Builder
public class EmailPO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long workflowExecutionId;
    private Long recipientAgentId;
    private Long teamId;
    private Integer status;
    private Instant createAt;
    private Instant updateAt;
}

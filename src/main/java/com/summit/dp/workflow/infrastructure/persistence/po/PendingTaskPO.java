package com.summit.dp.workflow.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.ibatis.type.JdbcType;

import java.time.Instant;

/**
 * 待发送任务行。
 *
 * <p>两段大文本都走 CLOB：正文上限 10 万字符，附件 JSON 会随图片数量增长，
 * 用 VARCHAR 在 H2 上等于重演旧 OOM 事故（见 V1 脚本开头的结论）。</p>
 *
 * <p>列名逐个显式标注：与同层其它 PO 一致，且不依赖全局下划线策略 —— 那类隐式约定
 * 在自建 SqlSessionFactory 的用例里会直接变成 {@code Column "SESSIONID" not found}。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("pending_task")
public class PendingTaskPO {

    /** 雪花 id：既作主键也作同会话内的派发顺序。 */
    @TableId(type = IdType.INPUT)
    private Long id;

    @TableField("session_id")
    private Long sessionId;

    @TableField(value = "input_text", jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String inputText;

    @TableField(value = "attachments", jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String attachments;

    @TableField("model_id")
    private Long modelId;

    @TableField("agent_id")
    private Long agentId;

    @TableField("workspace_id")
    private Long workspaceId;

    @TableField("require_plan")
    private Boolean requirePlan;

    /** PENDING / PAUSED / AWAITING_CONFIRM。 */
    @TableField("status")
    private String status;

    @TableField("failure")
    private String failure;

    @TableField("created_at")
    private Instant createdAt;

    @TableField("updated_at")
    private Instant updatedAt;
}

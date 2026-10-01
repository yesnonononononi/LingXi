package com.summit.dp.turn.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * chat_turn 表映射。
 *
 * <p>业务轮次是「用户单次请求」的权威记录，独立于框架 {@code execution}（后者是运行时快照）。
 * {@code execution_id} 可空：受理时框架执行可能还不存在；启动前就失败时永远为空。</p>
 *
 * <p>token 三列 {@code null} = 未采集到，{@code 0} = 确实为 0 —— 两者必须可区分，
 * 配合 MyBatis-Plus 默认的 NOT_NULL 更新策略，未赋值的列不会进入 UPDATE，
 * 因此「写 null」等价于「不改动已知值」。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("chat_turn")
public class ChatTurnPO {

    @TableId(type = IdType.INPUT)
    private Long id;

    @TableField("session_id")
    private Long sessionId;

    /** 发起本次子 Agent 委派的主轮次；普通用户提问为空。 */
    @TableField("parent_turn_id")
    private Long parentTurnId;

    /** 关联的框架执行 ID；可为空。 */
    @TableField("execution_id")
    private Long executionId;

    /** ACCEPTED / RUNNING / WAITING / COMPLETED / FAILED / CANCELLED。 */
    @TableField("status")
    private String status;

    @TableField("model_name")
    private String modelName;

    @TableField("model_provider")
    private String modelProvider;

    @TableField("input_token_count")
    private Long inputTokenCount;

    @TableField("output_token_count")
    private Long outputTokenCount;

    @TableField("total_token_count")
    private Long totalTokenCount;

    @TableField("started_at")
    private Instant startedAt;

    @TableField("completed_at")
    private Instant completedAt;

    /** 面向用户的失败原因；仅 status=FAILED 时渲染。 */
    @TableField("error_reason")
    private String errorReason;

    @TableField("created_at")
    private Instant createdAt;

    @TableField("updated_at")
    private Instant updatedAt;
}

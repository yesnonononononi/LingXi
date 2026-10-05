package com.summit.dp.execution.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

/**
 * {@code execution_resume_task} 表映射：只存恢复意图，不存事件。
 *
 * <p>时间列用 {@link LocalDateTime}：本表的时间只服务「退避后何时可再领」这一本地语义，
 * 不参与跨时区展示，与 {@code execution} 表的既有口径一致。</p>
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("execution_resume_task")
public class ExecutionResumeTaskPO {

    @TableId(type = IdType.AUTO)
    private Long id;

    @TableField("execution_id")
    private Long executionId;

    private Long generation;
    private String state;
    private Integer attempts;
    @TableField("next_attempt_at")
    private LocalDateTime nextAttemptAt;
    @TableField("error_reason")
    private String errorReason;
    private Long version;
    @TableField("created_at")
    private LocalDateTime createdAt;
    @TableField("updated_at")
    private LocalDateTime updatedAt;
}

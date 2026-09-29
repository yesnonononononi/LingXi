package com.summit.dp.execution.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * execution 表映射。
 *
 * <p>请求参数（systemPrompt / task / toolList / modelConfig / workspaceSpec / attributes 等）
 * 与执行元状态（errorMessage / startedAt / completedAt / maxSteps 等）全部由
 * {@code snapshot} 列承载，恢复路径 {@code findById} 只读 {@code status + snapshot}。
 * 因此这里只保留业务查询真正需要的列。</p>
 *
 * <p>本地模式：不再持久化 worker 归属、租约与控制指令，这些由框架的进程内
 * {@code InMemoryActiveExecutionRegistry} 通过 {@code ExecutionControlSignal} 承担。</p>
 */
@Data
@TableName("execution")
public class ExecutionPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    @TableField("session_id")
    private Long sessionId;
    @TableField("status")
    private Integer status;
    @TableField("snapshot")
    private String snapshot;
    @TableField("created_at")
    private LocalDateTime createdAt;
    @TableField("updated_at")
    private LocalDateTime updatedAt;
}

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
 * {@code snapshot} 列承载，恢复路径 {@code findById} 只读 {@code status + snapshot}。</p>
 *
 * <p><b>摘要列（2026-09-30 新增）：</b>{@code rootExecutionId / modelName / modelProvider /
 * inputTokenCount / outputTokenCount / totalTokenCount / startedAt / completedAt} 是
 * <b>查询与展示</b>专用的冗余列，让历史接口按 executionId 批量装配本轮统计，
 * 不必反序列化整个 snapshot。它们不参与恢复 —— 恢复路径仍然只读 status + snapshot，
 * 因此这里即使为 null 也不影响 resume。</p>
 *
 * <p><b>空值语义：</b>token 三列 {@code null} = 未采集到，{@code 0} = 确实为 0，
 * 两者必须可区分（旧数据不得显示成零消耗）。配合 MyBatis-Plus 默认的 NOT_NULL 更新策略，
 * 未赋值的字段不会进入 UPDATE 语句，因此「写 null」等价于「不改动已知值」。</p>
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
    /** 所属根执行 ID；主执行为 null，子执行指向发起委派的主执行。 */
    @TableField("root_execution_id")
    private Long rootExecutionId;
    /** 执行开始时实际解析出的模型名称快照（不是用户请求里可能为空的 modelId）。 */
    @TableField("model_name")
    private String modelName;
    /** 执行开始时实际解析出的模型提供方快照。 */
    @TableField("model_provider")
    private String modelProvider;
    /** 本执行累计已采集输入 token；null = 未知。 */
    @TableField("input_token_count")
    private Long inputTokenCount;
    /** 本执行累计已采集输出 token；null = 未知。 */
    @TableField("output_token_count")
    private Long outputTokenCount;
    /** 本执行累计已采集总 token；null = 未知。 */
    @TableField("total_token_count")
    private Long totalTokenCount;
    /** 执行首次开始时间；暂停后恢复不重置。 */
    @TableField("started_at")
    private LocalDateTime startedAt;
    /** 进入完成 / 失败 / 取消终态的时间；未结束为 null。 */
    @TableField("completed_at")
    private LocalDateTime completedAt;
    @TableField("status")
    private Integer status;
    @TableField("snapshot")
    private String snapshot;
    @TableField("created_at")
    private LocalDateTime createdAt;
    @TableField("updated_at")
    private LocalDateTime updatedAt;
}

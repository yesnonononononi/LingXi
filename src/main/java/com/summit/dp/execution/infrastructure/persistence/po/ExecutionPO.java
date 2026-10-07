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
 * <p><b>只保留框架自己的运行记录：</b>{@code started_at / completed_at}
 * 是给查询与收尸用的列，由检查点保存时同步维护。「用的哪个模型、花了多少 token」是业务事实，
 * 权威在 {@code chat_turn}（模型由业务受理时解析写入，用量由框架完成事件回填），
 * 本表不再冗余保存 —— 同一事实两处存放必然漂移。</p>
 *
 * <p>本地模式：不再持久化 worker 归属、租约与控制指令，这些由框架的进程内
 * {@code InMemoryActiveExecutionRegistry} 通过 {@code ExecutionControlSignal} 承担。</p>
 */
@Data
@TableName("execution")
public class ExecutionPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long version;

    @TableField("session_id")
    private Long sessionId;
    /** 执行首次开始时间；暂停后恢复不重置。 */
    @TableField("started_at")
    private LocalDateTime startedAt;
    /** 进入完成 / 失败 / 取消终态的时间；未结束为 null。 */
    @TableField("completed_at")
    private LocalDateTime completedAt;
    @TableField("status")
    private Integer status;
    /**
     * 恢复代际：执行实际从非 SUSPENDED 落为 SUSPENDED 时 +1。
     *
     * <p>业务持久化列，框架 {@code Execution} 对象无此字段 —— 代际只服务业务侧恢复意图的
     * 过期判定，不参与框架控制流。</p>
     */
    @TableField("resume_generation")
    private Long resumeGeneration;
    @TableField("snapshot")
    private String snapshot;
    @TableField("created_at")
    private LocalDateTime createdAt;
    @TableField("updated_at")
    private LocalDateTime updatedAt;
}

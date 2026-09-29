package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** 会话元数据持久化对象。消息与工作空间分别通过 id 关联独立表。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("session")
public class SessionPO {

    /** 根会话自身的 {@code root_session_id} 取值（无派生来源）。 */
    public static final long ROOT_SESSION_ID = 0L;

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long rootSessionId;
    /** 会话归属的 Agent；根会话/非 Agent 会话为 NULL，子代理会话为其子 Agent。 */
    private Long agentId;
    private String name;
    /** 关联 workspace 表，可空（会话未绑定工作空间） */
    private Long workspaceId;
    /**
     * 绑定的协作团队；NULL=非团队会话。
     *
     * <p><b>必须 IGNORED</b>：解绑（把 team_id 写回 NULL）是合法操作，而 MyBatis-Plus 的
     * {@code updateById} 默认跳过 null 字段 —— 不加这条，解绑会静默失效：领域模型已改成 null，
     * 库里仍是旧值，表现为「下拉框清空了团队但后端还在按团队编排」。</p>
     */
    @TableField(updateStrategy = FieldStrategy.IGNORED)
    private Long teamId;
    private int totalTokens;
    private int inputTokens;
    private int outputTokens;
    private Instant createTime;
    private Instant updateTime;


}

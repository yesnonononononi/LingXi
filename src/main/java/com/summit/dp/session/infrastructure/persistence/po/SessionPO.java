package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
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
    private String name;
    /** 关联 workspace 表，可空（会话未绑定工作空间） */
    private Long workspaceId;
    /** 绑定的协作团队，仅创建时写入；NULL=非团队会话 */
    private Long teamId;
    private int totalTokens;
    private int inputTokens;
    private int outputTokens;
    private Instant createTime;
    private Instant updateTime;


}

package com.summit.dp.session.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;

/**
 * 会话持久化对象，与领域实体 {@code ConversationEntity} 对齐（一条记录 = 一个会话聚合）。
 * <p>工作空间不再整段 JSON 内嵌，改为 {@code workspace_id} 关联独立的 workspace 表
 * （一个 workspace 可被多个会话复用），读取时由适配器装配回运行实例。</p>
 */
@Data
@Builder
@TableName("session")
public class SessionPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    /** 关联 workspace 表，可空（会话未绑定工作空间） */
    private Long workspaceId;
    /**
     * List<Message> -> json str（多态）
     */
    private String messages;
    private int totalTokens;
    private int inputTokens;
    private int outputTokens;
    private String systemMessage;
}

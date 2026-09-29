package com.summit.dp.email.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * Email 领域模型：<b>一次协作轮次里、一个收件 Agent 的角色邮箱</b>。
 *
 * <p>它不是一封消息，也不是某个 Agent 执行实例的邮箱。业务键是
 * {@code (workflowExecutionId, recipientAgentId)}，数据库上有唯一索引；相同协作轮次对同一个
 * Agent 的多封信进入同一邮箱，邮箱 id 由服务端生成并作为 {@code email_message.email_id} 的关联键。</p>
 *
 * <p>因此业务键两列与团队快照都在创建时确定、之后<b>不可修改</b>（本类不提供对应的 change 方法）；
 * 可变状态只有 {@link #status}，收敛为 {@link #changeStatus(Integer)}，并由领域方法统一触碰
 * {@code updateAt}。发信目标是 Agent 角色，不要求目标执行已创建；恢复或重启执行也不改变邮箱归属。</p>
 */
@Getter
@Builder
public class Email {

    /** 邮箱有效状态，与 {@code init.sql} 的 DDL 默认值保持一致。 */
    public static final int STATUS_ACTIVE = 1;

    private final Long id;

    /** 协作根执行 ID：根执行取自身 ID，子执行继承根执行 ID；仅用于隔离不同协作轮次。 */
    private final Long workflowExecutionId;

    /** 收件 Agent ID：只表示收件角色，不绑定任何执行实例。 */
    private final Long recipientAgentId;

    /** 创建时的团队快照，不参与投递路由；创建后不可修改。 */
    private final Long teamId;

    private Integer status;

    private final Instant createAt;

    private Instant updateAt;

    /**
     * 触碰更新时间：任何会改变聚合状态的写路径都应调用，
     * 保证 {@code updateAt} 由领域层（而非散落在应用层）统一维护。
     */
    public void update() {
        this.updateAt = Instant.now();
    }

    /** 变更状态并触碰 updateAt。 */
    public void changeStatus(Integer status) {
        this.status = status;
        update();
    }
}

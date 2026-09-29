package com.summit.dp.email.domain.repository;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.Email;

import java.util.Collection;
import java.util.Optional;

/**
 * Email 领域仓储。
 */
public interface EmailRepository extends RepositoryTemplate<Email, Long> {

    /**
     * 按标识集合批量查询（供应用层 queryIn 使用）。
     */
    Collection<Email> findList(Collection<Long> ids);

    /**
     * 分页查询，支持按收件 Agent / 团队快照过滤（任一为 null 表示不过滤该维度）。
     *
     * @param current          页码（从 1 开始）
     * @param size             页大小
     * @param recipientAgentId 收件 Agent，null 不过滤
     * @param teamId           团队快照，null 不过滤
     * @return 分页结果
     */
    IPage<Email> queryByPage(int current, int size, Long recipientAgentId, Long teamId);

    /**
     * 按邮箱业务键精确查询：{@code workflow_execution_id = ? AND recipient_agent_id = ?}。
     *
     * <p>这是投递与消费的唯一入口条件，不再使用两个执行 ID 的 {@code OR} 写法——
     * 旧写法下同一个执行 ID 命中任一列就会放行整封邮箱的待处理消息，无法说明消息到底
     * 发给某个 Agent、某次执行还是某个协作轮次。</p>
     *
     * @param workflowExecutionId 协作根执行 ID
     * @param recipientAgentId    收件 Agent ID
     * @return 邮箱；任一参数为 null 或无命中返回 {@link Optional#empty()}
     */
    Optional<Email> findByBusinessKey(Long workflowExecutionId, Long recipientAgentId);

    /**
     * 按业务键精确查询并加行锁（{@code SELECT ... FOR UPDATE}）。
     *
     * <p>专供「并发首次建箱冲突后的回查」这一条路径：MySQL 默认隔离级别是 REPEATABLE READ，
     * 事务内第一次一致性读就把 read view 固定下来，之后普通 {@code SELECT} <b>看不到</b>
     * 本事务读快照建立之后才提交的那一行。竞争方刚插入并提交的邮箱行正属于这种情况，
     * 只有当前读（锁定读）才能读到它，否则会误判成「回查失败」并回滚整次投递。</p>
     *
     * <p>只在这条冲突路径上使用，避免在正常投递路径上引入间隙锁与额外死锁面。</p>
     *
     * @return 邮箱；任一参数为 null 或无命中返回 {@link Optional#empty()}
     */
    Optional<Email> findByBusinessKeyForUpdate(Long workflowExecutionId, Long recipientAgentId);
}

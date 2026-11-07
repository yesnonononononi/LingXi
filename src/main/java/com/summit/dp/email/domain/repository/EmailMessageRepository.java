package com.summit.dp.email.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.EmailMessage;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * EmailMessage 领域仓储。
 */
public interface EmailMessageRepository extends RepositoryTemplate<EmailMessage, Long> {

    /** 唯一键冲突后使用当前读，避免事务快照漏掉竞争方已提交的通知。 */
    Optional<EmailMessage> findByDedupKeyForUpdate(String dedupKey);

    /**
     * 查询某封邮件下的全部消息，按 createAt, id 升序（与写入顺序一致）。
     */
    List<EmailMessage> findByEmailId(Long emailId);

    /**
     * 删除某封邮件下的全部消息（级联删除 email 聚合时使用）。
     */
    void deleteByEmailId(Long emailId);

    /**
     * 查询多封邮件下全部未消费（PENDING）消息，按 createAt, id 升序（供批量消费使用）。
     *
     * @param emailIds 邮件 id 集合，空集合返回空列表
     */
    List<EmailMessage> findPendingByEmailIds(Collection<Long> emailIds);

    /**
     * 查询多封邮件下 id 大于 {@code afterId} 的全部消息，按 id 升序。
     *
     * <p><b>为什么需要「含已消费」的查询</b>：注入路径的权威去重判据是随检查点持久化的游标，
     * 不是消息的全局消费状态。若这里仍按 PENDING 过滤，一旦「全局消费已生效、检查点没落库」
     * （崩溃窗口），重启后这批消息就再也取不到了 —— 输入被永久吞掉。
     * 按 id 游标取则只会重复注入一次，符合「宁可重复，不可丢失」的取舍。</p>
     *
     * @param emailIds 邮件 id 集合，空集合返回空列表
     * @param afterId  游标消息 id，返回 id 严格大于它的行
     */
    List<EmailMessage> findByEmailIdsAfterId(Collection<Long> emailIds, long afterId);

    /**
     * 单条条件更新：仅当该消息仍为 PENDING 时置为 CONSUMED 并触碰 update_at，
     * 消除 check-then-act 竞态窗口。
     *
     * @return 实际生效行数（0 表示消息不存在或已被消费）
     */
    int consumePendingById(Long id);

    /**
     * 批量条件更新：仅当消息仍为 PENDING 时置为 CONSUMED 并触碰 update_at。
     *
     * @param ids 消息 id 集合，空集合返回 0
     * @return 实际生效行数（供乐观并发校验：生效数应等于入参集合大小）
     */
    int consumePendingByIds(Collection<EmailMessage> messages);
}

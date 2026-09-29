package com.summit.dp.email.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.EmailMessage;

import java.util.Collection;
import java.util.List;

/**
 * EmailMessage 领域仓储。
 */
public interface EmailMessageRepository extends RepositoryTemplate<EmailMessage, Long> {

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

package com.summit.dp.email.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.EmailMessage;

import java.util.Collection;
import java.util.List;
import java.util.Map;
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
     * 查询多封邮件下「还没有投递回执」的全部消息，按 createAt, id 升序（只保证注入顺序稳定）。
     *
     * <p><b>为什么判据是回执而不是 {@code status}</b>：{@code status = CONSUMED} 只是展示态，
     * 「邮件已被清理、但回执还没落库」的窗口里按它过滤就永远取不到这条输入 —— 输入被静默吞掉。
     * 回执是逐条认领的权威事实，与 status 正交。</p>
     *
     * <p><b>为什么不按 id 游标取</b>：雪花 id 大小不代表提交顺序，较小 id 完全可能晚于较大 id 提交，
     * 被高水位永久挡住。回执判据与顺序无关。</p>
     *
     * @param emailIds 邮件 id 集合，空集合返回空列表
     */
    List<EmailMessage> findUndeliveredByEmailIds(Collection<Long> emailIds);

    /**
     * 只取 id → 所属邮箱的窄查询（回执落库用，不读正文 CLOB）。
     *
     * @param messageIds 消息 id 集合，空集合返回空 Map
     * @return 消息 id → 邮箱 id
     */
    Map<Long, Long> findEmailIdByIds(Collection<Long> messageIds);

    /**
     * 把给定消息中仍为 PENDING 的行置为 CONSUMED（展示态的尽力清理，不进任何判据）。
     *
     * @param messageIds 消息 id 集合，空集合返回 0
     * @return 实际生效行数
     */
    int consumeByIds(Collection<Long> messageIds);

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

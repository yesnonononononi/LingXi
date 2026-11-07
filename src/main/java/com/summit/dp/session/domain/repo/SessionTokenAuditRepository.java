package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionTokenAudit;

import java.util.Optional;

/**
 * 会话级 token 审计快照仓储。
 *
 * <p>接口只认领域模型，**不出现任何持久化类型**（PO / Mapper / Wrapper），
 * 实现下沉到 infrastructure。</p>
 *
 * <p>写入口只有两个：成功采集走 {@link #replaceSnapshot(SessionTokenAudit)}，
 * 失败走 {@link #markFailed(Long, Long, String)}。两者都必须保证「头表与明细表同事务」，
 * 否则会出现「工具数变多、SUM 对不上」这种半截快照。</p>
 */
public interface SessionTokenAuditRepository extends RepositoryTemplate<SessionTokenAudit, Long> {

    /**
     * 读某个会话当前的成功快照（含明细行）。
     *
     * @param sessionId 会话标识；null 直接返回空，不做「拿 null 查实体」的无意义查询
     * @return 快照；从未成功采集过时为 {@link Optional#empty()}
     */
    Optional<SessionTokenAudit> findBySessionId(Long sessionId);

    /**
     * 用新快照整体替换该会话的旧快照（同事务：头表 upsert + 明细先删后插）。
     *
     * <p>为什么明细必须先删：{@code saveOrUpdate} 只覆盖头表，旧工具名不会自动消失，
     * 上轮有、这轮没有的工具会一直留在明细里，TOOL 求和随之失控。</p>
     *
     * @param audit 新快照（状态必须是 {@code COLLECTED}）
     */
    void replaceSnapshot(SessionTokenAudit audit);

    /**
     * 把该会话的采集结果标记为失败。
     *
     * <p><b>已有成功快照时不生效</b>：一次失败不该摧毁手上唯一可解释的事实。
     * 失败原因在领域层截断到列宽，本层不再二次处理。</p>
     *
     * @param sessionId   会话标识
     * @param executionId 失败所在执行，可为 null
     * @param reason      失败原因，可为 null（走兜底文案）
     */
    void markFailed(Long sessionId, Long executionId, String reason);
}

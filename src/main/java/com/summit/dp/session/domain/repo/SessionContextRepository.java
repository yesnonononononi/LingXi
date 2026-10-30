package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionContext;

import java.util.List;
import java.util.Optional;

public interface SessionContextRepository extends RepositoryTemplate<SessionContext, Long> {
    void batchDeleteBySessionIds(List<Long> sessionIds);

    /**
     * 轻量摘要查询：只读 {@code session_id} 与 {@code version}，<b>不读正文</b>。
     *
     * <p>供「整体替换正文」使用：替换是覆盖写，不需要旧正文；返回对象的 {@code content}
     * 恒为 {@code null}，只能配合 {@code changeContent} 走更新，不能拿来当历史内容用。
     * 行不存在返回 {@code Optional.empty()}。</p>
     *
     * @param sessionId 会话标识
     */
    Optional<SessionContext> findSummary(Long sessionId);
}

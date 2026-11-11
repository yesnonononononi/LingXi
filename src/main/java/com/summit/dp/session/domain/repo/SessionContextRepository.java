package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionContext;

import java.util.List;
import java.util.Optional;

public interface SessionContextRepository extends RepositoryTemplate<SessionContext, Long> {
    void batchDeleteBySessionIds(List<Long> sessionIds);

    /**
     * 轻量摘要查询：只读 {@code session_id / version / snapshot_file}，<b>不读正文</b>。
     *
     * <p>两个用途共用它：判「行存不存在」（替换是覆盖写，不需要旧正文）与取「当前正文标识」
     * （正文在文件里，读它不经过库）。返回对象只带标识、版本与正文标识，不能当成历史内容用。
     * 行不存在返回 {@code Optional.empty()}。</p>
     *
     * @param sessionId 会话标识
     */
    Optional<SessionContext> findSummary(Long sessionId);
}

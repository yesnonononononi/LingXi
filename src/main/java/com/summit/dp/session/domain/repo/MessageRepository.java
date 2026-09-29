package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionMessage;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/** session_message 表仓储。 */
public interface MessageRepository extends RepositoryTemplate<SessionMessage, Long> {
    /** 会话全部消息，按雪花主键升序（旧 → 新）。 */
    List<SessionMessage> findBySessionId(Long sessionId);

    /**
     * 游标分页：按雪花主键 {@code id} 倒序取最多 limit 条，返回顺序为"新 → 旧"。
     *
     * @param cursorId 游标消息主键，取 {@code id < cursorId} 的更早消息；为空表示从最新一条开始
     */
    List<SessionMessage> findLatest(Long sessionId, Long cursorId, int limit);

    /** Append user-visible transcript messages without rewriting earlier history. */
    void appendAll(Long sessionId, List<SessionMessage> messages);

    /** 会话的消息条数。 */
    long countBySessionId(Long sessionId);

    /** 批量统计多个会话的消息条数，避免逐会话 count 的 N+1。 */
    Map<Long, Long> countBySessionIds(Collection<Long> sessionIds);

    void deleteBySessionId(Long sessionId);

    void batchDelBySessionIds(List<Long> ids);
}

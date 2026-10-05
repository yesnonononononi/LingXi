package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionMessage;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** session_message 表仓储。 */
public interface MessageRepository extends RepositoryTemplate<SessionMessage, Long> {
    default Optional<SessionMessage> findByStreamKey(Long sessionId, String key) {
        return findBySessionId(sessionId).stream().filter(message -> key.equals(message.getStreamKey())).findFirst();
    }
    /** 会话全部消息，按雪花主键升序（旧 → 新）。 */
    List<SessionMessage> findBySessionId(Long sessionId);

    /**
     * 游标分页：按雪花主键 {@code id} 倒序取最多 limit 条，返回顺序为"新 → 旧"。
     *
     * @param cursorId 游标消息主键，取 {@code id < cursorId} 的更早消息；为空表示从最新一条开始
     */
    List<SessionMessage> findLatest(Long sessionId, Long cursorId, int limit);

    /**
     * 落库并随通知带上根身份。
     *
     * @param rootSessionId v3 投递目标（根会话）；子会话消息必须传根，否则投错连接桶
     */
    void save(SessionMessage message, Long rootSessionId);

    /**
     * 追加用户可见的 transcript 消息，不改写更早历史。
     *
     * @param sessionId     实体归属会话（子会话即子会话自身）
     * @param rootSessionId v3 投递目标（根会话）；子会话消息必须传根，否则投错连接桶
     */
    void appendAll(Long sessionId, Long rootSessionId, List<SessionMessage> messages);

    /**
     * 删除目标轮次及其之后的全部消息，返回删除行数。
     *
     * <p>transcript 唯一的删除入口，只服务「重发」的会话回滚；常规链路一律只追加。
     * 按 {@code turn_id} 切而不是按消息主键切：重发的目标本来就是「哪一轮」，
     * 轮次与消息因此用同一个切点，两个语义不必各找各的锚点。归属未知的旧行
     * （{@code turn_id} 为 null）不受影响，它们必然早于任何一轮。</p>
     */
    int deleteFromTurn(Long sessionId, Long fromTurnId);

    /** 会话的消息条数。 */
    long countBySessionId(Long sessionId);

    /** 批量统计多个会话的消息条数，避免逐会话 count 的 N+1。 */
    Map<Long, Long> countBySessionIds(Collection<Long> sessionIds);

    void deleteBySessionId(Long sessionId);

    void batchDelBySessionIds(List<Long> ids);
}

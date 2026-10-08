package com.summit.dp.session.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.SessionMessage;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** session_message 表仓储。 */
public interface MessageRepository extends RepositoryTemplate<SessionMessage, Long> {
    /**
     * 按响应身份取已落库的 AI 行，用于「同一轮重复落库」的幂等拦截。
     *
     * <p>走 {@code (session_id, response_id)} 唯一索引，而非在内存里全量扫描比对
     * —— 幂等检查在每一轮模型输出时都会执行，扫描会随会话长度线性变慢。</p>
     *
     * @param responseId 框架下发的响应身份；{@code null} 表示身份未知，恒返回空
     */
    Optional<SessionMessage> findByResponseId(Long sessionId, UUID responseId);

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
     * 锁定会话行，用于把「同一轮的重复落库判定」串行化（{@code SELECT ... FOR UPDATE}）。
     *
     * <p>为什么锁会话行而不是轮次行：轮次仅在正常路径存在（异常构造的执行没有 chat_turn 行），
     * 而落库必须对每个会话无条件可用。锁对象只要**同一会话的并发落库共用同一个**即可完成串行化，
     * 会话行满足这一点且必然存在。</p>
     *
     * <p>必须与 {@link #findByResponseId} 在同一事务内调用：先锁再查，后到的并发方会阻塞在锁上，
     * 待先到方提交后才读到它写入的 AI 行 —— 否则「先查再插」的检查会被并发方穿透
     * （check-then-act 竞态），双方都通过检查再一起去撞 {@code uk_session_response_id}。</p>
     *
     * <p>只服务于落库幂等这一条路径，不在读路径引入间隙锁与额外死锁面。</p>
     */
    void lockSessionForAppend(Long sessionId);

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

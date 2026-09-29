package com.summit.dp.session.application.service;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.model.CursorResult;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

/** 在应用层聚合 session 与 session_message 两个仓储。 */
@Service
@RequiredArgsConstructor
public class SessionAggregateService {
    private static final int DEFAULT_MESSAGE_PAGE_SIZE = 50;
    private static final int MAX_MESSAGE_PAGE_SIZE = 200;

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ToolCallRepository toolCallRepository;
    private final ModelContextService modelContextService;
    private final SessionContextRepository sessionContextRepository;


    @Transactional
    public Long save(Session session) {
        boolean exists = session.getId() != null && sessionRepository.findById(session.getId()).isPresent();
        Long id;
        if (exists) {
            sessionRepository.updateById(session);
            id = session.getId();
        } else {
            id = sessionRepository.saveAndReturnId(session);
        }
        return id;
    }

    /**
     * 按主键取会话；查不到即视为不存在。
     *
     * <p>本地单实例（HC-1）没有归属维度：会话的可见性由「知道 id」这一事实承载，
     * 与消息、工作空间一致。</p>
     */
    public Session requireOwned(Long sessionId) {
        return sessionRepository.findById(sessionId)
                .orElseThrow(SessionNoFoundException::new);
    }

    public Optional<Session> findById(Long id) {
        return sessionRepository.findById(id).map(session -> withMessages(session,
                messageRepository.findBySessionId(id)));
    }

    /**
     * 按「根会话 + Agent」取已存在的子代理会话（不含消息，调用方按需再取）。
     *
     * <p>委派工具用它实现「优先复用、按需派生」：同一根会话下同一 Agent 只维护一个子会话，
     * 复用时把新任务作为新 USER 消息追加进去，让子 Agent 带着历史继续。</p>
     */
    public Optional<Session> findByRootAndAgent(Long rootSessionId, Long agentId) {
        return sessionRepository.findByRootAndAgent(rootSessionId, agentId);
    }

    @Transactional
    public boolean deleteById(Long id) {
        // 仓储先解析根会话，删掉整棵树，返回值必然非空。
        List<Long> ids = sessionRepository.delSessionTreeByRootSId(id);
        messageRepository.batchDelBySessionIds(ids);
        // 级联清理工具调用（卡片数据）：按 conversation_id 批量删除，避免孤儿卡片无界累积。
        toolCallRepository.deleteByConversationIds(ids);
        modelContextService.deleteBySessionIds(ids);
        sessionContextRepository.batchDeleteBySessionIds(ids);
        return true;
    }

    /**
     * 按雪花主键游标取一页消息：首屏返回最新的一页，向上翻页返回更早的一页。分页下推到 SQL：
     * 仓储层带 LIMIT 查询，这里只是多取一条（limit+1）用于判断是否还有更早消息，再丢掉多出来的那条，
     * 不会把整会话消息读进内存。
     *
     * @param cursor 上一页最老一条消息的 id，为空表示从最新一条开始
     */
    public CursorResult<SessionMessage> messageSlice(Long sessionId, String cursor, Integer size) {
        int pageSize = Math.clamp(size == null || size < 1 ? DEFAULT_MESSAGE_PAGE_SIZE : size, 1,
                MAX_MESSAGE_PAGE_SIZE);

        Long cursorId = parseCursor(cursor);

        List<SessionMessage> fetched = messageRepository.findLatest(sessionId, cursorId, pageSize + 1);

        boolean hasMore = fetched.size() > pageSize;

        List<SessionMessage> latest = hasMore ? fetched.subList(0, pageSize) : fetched;

        List<SessionMessage> records = new ArrayList<>(latest);
        Collections.reverse(records);

        if (records.isEmpty()) {
            return CursorResult.empty();
        }
        return new CursorResult<>(records, hasMore ? String.valueOf(records.getFirst().getId()) : null, hasMore);
    }

    /** 会话是否存在，用于参数校验；不加载消息。 */
    public boolean exists(Long id) {
        return sessionRepository.findById(id).isPresent();
    }

    /**
     * 会话树：根会话 + 其下全部子会话，一次查询平铺返回（列表里含根会话自身）。
     * <p>只取会话元数据，不加载消息正文：前端用 {@code id == rootSessionId} 判根，
     * 子会话详情再按其 id 单独分页拉消息。
     *
     * @param sessionId 根会话 id 或任意子会话 id，会自动解析出真正的根会话
     */
    public SessionTree sessionTree(Long sessionId) {
        Session session = requireOwned(sessionId);
        Long rootSessionId = session.isSubSession() ? session.getRootSessionId() : session.getId();
        return new SessionTree(rootSessionId,
                sessionRepository.findSessionTree(rootSessionId));
    }

    /** 会话消息条数。 */
    public long countMessages(Long sessionId) {
        return messageRepository.countBySessionId(sessionId);
    }

    /** 批量统计会话消息条数，一次查询代替逐会话 count。 */
    public Map<Long, Long> countMessages(Collection<Long> sessionIds) {
        return messageRepository.countBySessionIds(sessionIds);
    }

    /**
     * 根会话分页。列表视图只需要会话元数据，不加载消息正文（消息按需走
     * {@link #messageSlice(Long, String, Integer)} 游标分页）。
     */
    public Page<Session> page(int current, int size) {
        IPage<Session> source = sessionRepository.queryRootPage(current, size);
        Page<Session> result = new Page<>(source.getCurrent(), source.getSize(), source.getTotal());
        result.setRecords(source.getRecords());
        return result;
    }

    private Session withMessages(Session session, List<SessionMessage> messages) {
        return session.toBuilder().messages(messages).build();
    }

    /** 会话树查询结果：根会话 id + 平铺的会话列表（其中 id == rootSessionId 的那条即根会话）。 */
    public record SessionTree(Long rootSessionId, List<Session> sessions) {
    }

    /** 游标 = 本页最老一条消息的雪花主键；下一页取 id 更小的（更早）消息。 */
    private static Long parseCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) return null;
        try {
            return Long.valueOf(cursor.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

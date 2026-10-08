package com.summit.dp.session.application.service;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

/** 在应用层聚合 session 与 session_message 两个仓储。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SessionAggregateService {
    private static final int DEFAULT_MESSAGE_PAGE_SIZE = 50;
    private static final int MAX_MESSAGE_PAGE_SIZE = 200;

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    /** 历史分页的游标维度：分页单位是完整轮次，轮次仓储是取数与游标的真源。 */
    private final ChatTurnRepository chatTurnRepository;
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

    /** 终结执行未采集用量时保留旧值，不能把缺失数据写成零。 */
    @Transactional
    public void saveExecutionContextUsage(Execution execution) {
        ContextUsageMetric metric = execution == null ? null : execution.getContextUsageMetric();
        if (metric == null) return;
        Map<String, Object> attributes = execution.getAgentRequest() == null
                ? Map.of() : execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        if (sessionId == null) {
            log.warn("终结执行缺少会话归属，用量快照丢弃: executionId={}", execution.getId());
            return;
        }
        Session session = sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        session.changeContextUsage((long) metric.tokenCount(), metric.maxTokens(), metric.ratio());
        sessionRepository.updateById(session);
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
     * 按**轮次**游标取一页历史：分页单位是「完整的一轮」而非「一行消息」。
     *
     * <p><b>为什么换单位</b>：按消息行切时，同一轮次可横跨两页 —— 前端必须逐页累计再聚合，
     * 否则同一轮会被建成两个气泡。按轮次切从根上消除这种跨页，前端的对账逻辑随之收敛为一套。</p>
     *
     * <p><b>游标是轮次主键</b>：雪花主键单调递增，{@code chat_turn.id} 天然表达先后。
     * 多取一条（limit+1）判断是否还有更早的一页，再丢掉多出来的那条，不把整会话读进内存。</p>
     *
     * <p><b>归属未知的旧行</b>（{@code turn_id IS NULL}）无法进入轮次分页，整批拼在历史最前面
     * 一次返回 —— 它们按定义早于任何一轮，不与游标边界冲突。</p>
     *
     * @param cursor 上一页最老一轮的 id，为空表示从最新一轮开始
     */
    public CursorResult<SessionMessage> messageSlice(Long sessionId, String cursor, Integer size) {
        int pageSize = Math.clamp(size == null || size < 1 ? DEFAULT_MESSAGE_PAGE_SIZE : size, 1,
                MAX_MESSAGE_PAGE_SIZE);

        Long cursorTurnId = parseCursor(cursor);

        // 先取轮次（一页 + 多取一条用于判断 hasMore），再按这批轮次整组取消息。
        List<ChatTurn> fetchedTurns = chatTurnRepository.findLatest(sessionId, cursorTurnId, pageSize + 1);

        boolean hasMore = fetchedTurns.size() > pageSize;

        List<ChatTurn> pageTurns = hasMore ? fetchedTurns.subList(0, pageSize) : fetchedTurns;

        // 首屏（无游标）才拼旧的无归属行：翻页时它们必然早已随第一页返回，重复拼会翻倍。
        List<SessionMessage> records = new ArrayList<>();
        if (cursorTurnId == null) {
            records.addAll(messageRepository.findOrphanPage(sessionId, MAX_MESSAGE_PAGE_SIZE));
        }
        if (!pageTurns.isEmpty()) {
            List<Long> turnIds = pageTurns.stream().map(ChatTurn::getId).toList();
            records.addAll(messageRepository.findByTurnIds(sessionId, turnIds));
            records.sort(Comparator.comparing(SessionMessage::getId, Comparator.nullsLast(Comparator.naturalOrder())));
        }

        if (records.isEmpty()) {
            return CursorResult.empty();
        }
        // 下一页游标 = 本页最老一轮的 id（pageTurns 已按 id 降序，末位即最老）。
        Long nextCursorTurnId = hasMore ? pageTurns.getLast().getId() : null;
        return new CursorResult<>(records, nextCursorTurnId == null ? null : String.valueOf(nextCursorTurnId), hasMore);
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

    /** 游标 = 本页最老一轮的 {@code chat_turn.id}；下一页取 id 更小的（更早的）轮次。 */
    private static Long parseCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) return null;
        try {
            return Long.valueOf(cursor.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

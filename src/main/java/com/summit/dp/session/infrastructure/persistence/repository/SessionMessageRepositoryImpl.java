package com.summit.dp.session.infrastructure.persistence.repository;

import cn.hutool.core.util.IdUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
@RequiredArgsConstructor
public class SessionMessageRepositoryImpl
        extends AbstractRepository<SessionMessage, SessionMessagePO, Long>
        implements MessageRepository {
    private final SessionMessageMapper messageMapper;
    private final SessionMapper sessionMapper;

    @Override
    public void save(SessionMessage message) {
        super.save(message);
    }

    /**
     * 落库并保留根身份入参。
     *
     * <p>{@code rootSessionId} 曾是投影的投递目标；协议渲染移除后该参数不再参与投递，
     * 但接口保留以免调用方到处改动。</p>
     */
    @Override
    public void save(SessionMessage message, Long rootSessionId) {
        super.save(message);
    }

    @Override
    public Optional<SessionMessage> findByResponseId(Long sessionId, String responseId) {
        if (responseId == null) return Optional.empty();
        return Optional.ofNullable(messageMapper.selectOne(Wrappers.<SessionMessagePO>lambdaQuery()
                .eq(SessionMessagePO::getSessionId, sessionId)
                .eq(SessionMessagePO::getResponseId, responseId))).map(this::toModel);
    }

    @Override
    public List<SessionMessage> findBySessionId(Long sessionId) {
        return messageMapper.selectList(Wrappers.<SessionMessagePO>lambdaQuery()
                        .eq(SessionMessagePO::getSessionId, sessionId)
                        .orderByAsc(SessionMessagePO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<SessionMessage> findLatest(Long sessionId, Long cursorId, int limit) {
        LambdaQueryWrapper<SessionMessagePO> wrapper = Wrappers.<SessionMessagePO>lambdaQuery()
                .eq(SessionMessagePO::getSessionId, sessionId)
                .ne(SessionMessagePO::getType,SessionMessageType.SYSTEM.name());  // filter system message
        if (cursorId != null) {
            // 雪花主键严格单调：id 更小即更早，(session_id, id) 索引可直接倒序范围扫描
            wrapper.lt(SessionMessagePO::getId, cursorId);
        }
        wrapper.orderByDesc(SessionMessagePO::getId)
                .last("LIMIT " + Math.max(limit, 1));
        return messageMapper.selectList(wrapper).stream().map(this::toModel).toList();
    }

    @Override
    public List<SessionMessage> findByTurnIds(Long sessionId, Collection<Long> turnIds) {
        if (sessionId == null || turnIds == null || turnIds.isEmpty()) {
            return List.of();
        }
        // 分页单位是完整轮次：一页给一组 turnId，整轮的行一次取回，不再按主键区间切。
        return messageMapper.selectList(Wrappers.<SessionMessagePO>lambdaQuery()
                        .eq(SessionMessagePO::getSessionId, sessionId)
                        .in(SessionMessagePO::getTurnId, turnIds)
                        .ne(SessionMessagePO::getType, SessionMessageType.SYSTEM.name())
                        .orderByAsc(SessionMessagePO::getId))
                .stream().map(this::toModel).toList();
    }

    /**
     * 取归属未知的旧消息（{@code turn_id IS NULL}）。
     *
     * <p>这些行早于「归属落到消息行」的改造，无法进入按轮次分页的口径。整批放到历史最前面
     * 一次性返回，让它们照常可见；按定义它们必然早于任何一轮，不与轮次分页的边界冲突。</p>
     */
    @Override
    public List<SessionMessage> findOrphanPage(Long sessionId, int limit) {
        if (sessionId == null) {
            return List.of();
        }
        return messageMapper.selectList(Wrappers.<SessionMessagePO>lambdaQuery()
                        .eq(SessionMessagePO::getSessionId, sessionId)
                        .isNull(SessionMessagePO::getTurnId)
                        .ne(SessionMessagePO::getType, SessionMessageType.SYSTEM.name())
                        .orderByAsc(SessionMessagePO::getId)
                        .last("LIMIT " + Math.max(limit, 1)))
                .stream().map(this::toModel).toList();
    }

    @Override
    public void appendAll(Long sessionId, Long rootSessionId, List<SessionMessage> messages) {
        if (messages == null || messages.isEmpty()) return;
        for (SessionMessage message : messages) {
            save(SessionMessage.builder()
                    .id(message.getId())
                    .responseId(message.getResponseId())
                    .sessionId(sessionId)
                    .turnId(message.getTurnId())
                    .responseOrder(message.getResponseOrder())
                    .type(message.getType())
                    .text(message.getText())
                    .createTime(message.getCreateTime())
                    .build(), rootSessionId);
        }
    }

    /**
     * 锁定会话行（{@code SELECT ... FOR UPDATE}）。
     *
     * <p>走主键等值锁既有行，不带间隙锁。会话在落库期间必然存在 —— 不存在则是真实的调用错误，
     * 不该被静默吞掉（用 {@code selectOne} 拿到 null 即抛，让上游看到「锁不住就不保证幂等」）。</p>
     */
    @Override
    public void lockSessionForAppend(Long sessionId) {
        if (sessionId == null) return;
        SessionPO locked = sessionMapper.selectOne(Wrappers.<SessionPO>lambdaQuery()
                .select(SessionPO::getId)
                .eq(SessionPO::getId, sessionId)
                .last("FOR UPDATE"));
        if (locked == null) {
            throw new IllegalStateException("落库前锁定会话失败: sessionId=" + sessionId + " 不存在");
        }
    }

    @Override
    public long countAiMessagesInTurn(Long sessionId, Long turnId) {
        if (sessionId == null || turnId == null) return 0L;
        return messageMapper.selectCount(Wrappers.<SessionMessagePO>lambdaQuery()
                .eq(SessionMessagePO::getSessionId, sessionId)
                .eq(SessionMessagePO::getTurnId, turnId)
                .eq(SessionMessagePO::getType, SessionMessageType.AI.name()));
    }

    @Override
    public int deleteFromTurn(Long sessionId, Long fromTurnId) {
        if (sessionId == null || fromTurnId == null) return 0;
        return messageMapper.delete(Wrappers.<SessionMessagePO>lambdaQuery()
                .eq(SessionMessagePO::getSessionId, sessionId)
                .ge(SessionMessagePO::getTurnId, fromTurnId));
    }

    @Override
    public long countBySessionId(Long sessionId) {
        return messageMapper.countBySessionId(sessionId);
    }

    @Override
    public Map<Long, Long> countBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return Map.of();
        QueryWrapper<SessionMessagePO> wrapper = Wrappers.<SessionMessagePO>query()
                .select("session_id", "COUNT(*) AS cnt")
                .in("session_id", sessionIds)
                .groupBy("session_id");
        Map<Long, Long> counts = new HashMap<>();
        for (Map<String, Object> row : messageMapper.selectMaps(wrapper)) {
            Object sessionId = row.get("session_id");
            Object cnt = row.get("cnt");
            if (sessionId == null) continue;
            counts.put(((Number) sessionId).longValue(), cnt == null ? 0L : ((Number) cnt).longValue());
        }
        return counts;
    }

    @Override
    public void deleteBySessionId(Long sessionId) {
        delete(sessionId, SessionMessagePO::getSessionId);
    }

    @Override
    public void batchDelBySessionIds(List<Long> ids) {
        if (ids == null || ids.isEmpty()) return;
        messageMapper.delete(Wrappers.<SessionMessagePO>lambdaQuery()
                .in(SessionMessagePO::getSessionId, ids));
    }

    @Override
    protected SessionMessagePO toPO(SessionMessage message) {
        // 雪花主键由应用层统一生成：趋势递增，插入集中在索引最右侧，页分裂概率接近自增
        Long id = message.getId() == null ? IdUtil.getSnowflakeNextId() : message.getId();
        return SessionMessagePO.builder().id(id).sessionId(message.getSessionId())
                .responseId(message.getResponseId())
                .turnId(message.getTurnId())
                .responseOrder(message.getResponseOrder())
                .type(message.getType() == null ? null : message.getType().name())
                .content(message.getText())
                .createTime(message.getCreateTime()).build();
    }

    @Override
    protected SessionMessage toModel(SessionMessagePO po) {
        return SessionMessage.builder().id(po.getId()).sessionId(po.getSessionId())
                .responseId(po.getResponseId())
                .turnId(po.getTurnId())
                .responseOrder(po.getResponseOrder())
                .type(po.getType() == null ? null : SessionMessageType.valueOf(po.getType()))
                .text(po.getContent())
                .createTime(po.getCreateTime()).build();
    }

    @Override
    protected @NotNull BaseMapper<SessionMessagePO> mapper() {
        return messageMapper;
    }
}

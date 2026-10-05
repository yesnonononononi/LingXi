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
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.shared.event.CommittedStateChange;
import org.springframework.beans.factory.annotation.Autowired;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import lombok.RequiredArgsConstructor;
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
    @Autowired(required = false)
    private CommittedStatePublisher statePublisher;

    @Override
    public void save(SessionMessage message) {
        super.save(message);
        publishCommitted(message, null);
    }

    /**
     * 落库并随通知带上根身份与已提交事实。
     *
     * <p>{@code rootSessionId} 是 v3 的**投递目标**（前端只订阅根连接），{@code message.getSessionId()}
     * 是**实体归属**。子会话消息必须由调用方传入根，否则会投进子会话桶而无人接收。</p>
     */
    @Override
    public void save(SessionMessage message, Long rootSessionId) {
        super.save(message);
        publishCommitted(message, rootSessionId);
    }

    /** 随通知带上已提交事实：v3 观察者据此直接构造 MESSAGE_COMMITTED（含原 streamKey），不再回查本行。 */
    private void publishCommitted(SessionMessage message, Long rootSessionId) {
        if (statePublisher == null) return;
        statePublisher.publish(CommittedStateChange.of(
                CommittedStateChange.Kind.MESSAGE, rootSessionId, message.getSessionId(), message.getId(), message));
    }

    @Override
    public Optional<SessionMessage> findByStreamKey(Long sessionId, String streamKey) {
        return Optional.ofNullable(messageMapper.selectOne(Wrappers.<SessionMessagePO>lambdaQuery()
                .eq(SessionMessagePO::getSessionId, sessionId).eq(SessionMessagePO::getStreamKey, streamKey))).map(this::toModel);
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
    public void appendAll(Long sessionId, Long rootSessionId, List<SessionMessage> messages) {
        if (messages == null || messages.isEmpty()) return;
        for (SessionMessage message : messages) {
            save(SessionMessage.builder()
                    .id(message.getId())
                    .streamKey(message.getStreamKey())
                    .sessionId(sessionId)
                    .turnId(message.getTurnId())
                    .type(message.getType())
                    .text(message.getText())
                    .createTime(message.getCreateTime())
                    .build(), rootSessionId);
        }
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
                .streamKey(message.getStreamKey())
                .turnId(message.getTurnId())
                .type(message.getType() == null ? null : message.getType().name())
                .content(message.getText())
                .createTime(message.getCreateTime()).build();
    }

    @Override
    protected SessionMessage toModel(SessionMessagePO po) {
        return SessionMessage.builder().id(po.getId()).sessionId(po.getSessionId())
                .streamKey(po.getStreamKey())
                .turnId(po.getTurnId())
                .type(po.getType() == null ? null : SessionMessageType.valueOf(po.getType()))
                .text(po.getContent())
                .createTime(po.getCreateTime()).build();
    }

    @Override
    protected @NotNull BaseMapper<SessionMessagePO> mapper() {
        return messageMapper;
    }
}

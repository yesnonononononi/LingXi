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
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Repository
@RequiredArgsConstructor
public class SessionMessageRepositoryImpl
        extends AbstractRepository<SessionMessage, SessionMessagePO, Long>
        implements MessageRepository {
    private final SessionMessageMapper messageMapper;

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
    public void appendAll(Long sessionId, List<SessionMessage> messages) {
        if (messages == null || messages.isEmpty()) return;
        for (SessionMessage message : messages) {
            save(SessionMessage.builder()
                    .id(message.getId())
                    .sessionId(sessionId)
                    .type(message.getType())
                    .text(message.getText())
                    .createTime(message.getCreateTime())
                    .build());
        }
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
                .type(message.getType() == null ? null : message.getType().name())
                .content(message.getText())
                .createTime(message.getCreateTime()).build();
    }

    @Override
    protected SessionMessage toModel(SessionMessagePO po) {
        return SessionMessage.builder().id(po.getId()).sessionId(po.getSessionId())
                .type(po.getType() == null ? null : SessionMessageType.valueOf(po.getType()))
                .text(po.getContent())
                .createTime(po.getCreateTime()).build();
    }

    @Override
    protected @NotNull BaseMapper<SessionMessagePO> mapper() {
        return messageMapper;
    }
}

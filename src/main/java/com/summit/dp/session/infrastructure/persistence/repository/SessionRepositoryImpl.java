package com.summit.dp.session.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.TokenUsage;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
@RequiredArgsConstructor
public class SessionRepositoryImpl extends AbstractRepository<Session, SessionPO, Long>
        implements SessionRepository {
    private final SessionMapper sessionMapper;

    @Override
    public Long saveAndReturnId(Session session) {
        Number id = save(session, SessionPO::getId);
        return id == null ? null : id.longValue();
    }

    @Override
    public IPage<Session> queryRootPage(int current, int size) {
        long offset = (long) (Math.max(current, 1) - 1) * Math.max(size, 1);
        long total = sessionMapper.countRoot(Session.ROOT_SESSION_ID);
        List<SessionPO> source = sessionMapper.selectRootPage(SessionPO.ROOT_SESSION_ID, offset, Math.max(size, 1));
        Page<Session> result = new Page<>(current, size, total);
        result.setRecords(source.stream().map(this::toModel).toList());
        return result;
    }

    @Override
    public List<Session> findSessionTree(Long rootSessionId) {
        return sessionMapper.selectSessionTree(rootSessionId).stream().map(this::toModel).toList();
    }

    /**
     * 删除会话树。{@code id} 是「根会话或子会话」的 id，删除的是其所属整棵树。
     *
     * <p>入参 id 先按主键解析成根会话 id，再走树查询收集整棵树的会话并删除；
     * id 不存在时抛「会话不存在」。</p>
     */
    @Override
    public List<Long> delSessionTreeByRootSId(Long id) {
        if (id == null) {
            throw new SessionNoFoundException();
        }
        Session owned = findBy(new QueryWrapper<SessionPO>()
                .eq("id", id))
                .orElseThrow(SessionNoFoundException::new);
        Long rootSessionId = owned.getRootSessionId();
        Long rootId = rootSessionId == null || rootSessionId == SessionPO.ROOT_SESSION_ID
                ? owned.getId()
                : rootSessionId;

        List<Long> list = sessionMapper.selectSessionTree(rootId).stream().map(SessionPO::getId).toList();
        if (list.isEmpty()) {
            return list;
        }
        sessionMapper.deleteByIds(list);
        return list;
    }

    @Override
    protected SessionPO toPO(Session session) {
        TokenUsage usage =  session.getTokenUsage();
        return SessionPO.builder().id(session.getId()).name(session.getName()).workspaceId(session.getWorkspaceId())
                .rootSessionId(session.getRootSessionId() == null ? SessionPO.ROOT_SESSION_ID
                        : session.getRootSessionId())
                .teamId(session.getTeamId())
                .totalTokens(usage.totalTokens()).inputTokens(usage.inputTokens()).outputTokens(usage.outputTokens())
                .build();
    }

    @Override
    protected Session toModel(SessionPO po) {
        return Session.builder().id(po.getId()).name(po.getName()).workspaceId(po.getWorkspaceId())
                .rootSessionId(po.getRootSessionId())
                .teamId(po.getTeamId())
                .tokenUsage(new TokenUsage(po.getTotalTokens(), po.getInputTokens(), po.getOutputTokens()))
                .createTime(po.getCreateTime()).updateTime(po.getUpdateTime())
                .build();
    }

    @Override
    protected @NotNull BaseMapper<SessionPO> mapper() {
        return sessionMapper;
    }
}

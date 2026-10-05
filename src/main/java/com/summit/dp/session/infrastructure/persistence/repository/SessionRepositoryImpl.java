package com.summit.dp.session.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.shared.event.CommittedStateChange;
import org.springframework.beans.factory.annotation.Autowired;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;
import java.util.Collection;

@Repository
@RequiredArgsConstructor
public class SessionRepositoryImpl extends AbstractRepository<Session, SessionPO, Long>
        implements SessionRepository {
    private final SessionMapper sessionMapper;
    @Autowired(required = false)
    private CommittedStatePublisher statePublisher;

    @Override
    public void save(Session session) { saveAndReturnId(session); }

    @Override
    public void updateById(@NotNull Session session) {
        SessionPO row = toPO(session);
        long expected = session.getVersion();
        row.setVersion(expected + 1);
        if (sessionMapper.update(row, Wrappers.<SessionPO>lambdaUpdate()
                .eq(SessionPO::getId, session.getId()).eq(SessionPO::getVersion, expected)) != 1) {
            throw new ClientException("会话状态已变化，请刷新后重试");
        }
        session.acceptPersistedVersion(expected + 1);
        // 带上落库终值快照：v3 观察者直接转换，不再回查会话行。
        if (statePublisher != null) statePublisher.publish(CommittedStateChange.of(
                CommittedStateChange.Kind.SESSION, session.getId(), session.getId(), session));
    }

    @Override
    public void update(Collection<Session> sessions) { sessions.forEach(this::updateById); }

    @Override
    public Long saveAndReturnId(Session session) {
        SessionPO row = toPO(session);
        sessionMapper.insert(row);
        // insert 后 row 才带自增主键：用 toModel 还原成领域快照再下发，保证版本/代际字段口径一致。
        if (statePublisher != null) statePublisher.publish(CommittedStateChange.of(
                CommittedStateChange.Kind.SESSION, row.getId(), row.getId(), toModel(row)));
        return row.getId();
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
     * 按「根会话 + Agent」取已存在的子会话，取最新一条。
     *
     * <p>{@code null} 入参直接返回空：不做「拿 null 查实体」的无意义查询，也不让它匹配上
     * 任何一行（M8 的语义是「这个 Agent 的子会话是否已存在」）。</p>
     */
    @Override
    public Optional<Session> findByRootAndAgent(Long rootSessionId, Long agentId) {
        if (rootSessionId == null || agentId == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(sessionMapper.selectLatestByRootAndAgent(rootSessionId, agentId))
                .map(this::toModel);
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
        return SessionPO.builder().id(session.getId()).name(session.getName()).workspaceId(session.getWorkspaceId())
                .version(session.getVersion()).historyRevision(session.getHistoryRevision())
                .rootSessionId(session.getRootSessionId() == null ? SessionPO.ROOT_SESSION_ID
                        : session.getRootSessionId())
                .agentId(session.getAgentId())
                .teamId(session.getTeamId())
                .contextTokenCount(session.getContextTokenCount())
                .contextMaxTokens(session.getContextMaxTokens())
                .contextRatio(session.getContextRatio() == null ? null
                        : BigDecimal.valueOf(session.getContextRatio()))
                .build();
    }

    @Override
    protected Session toModel(SessionPO po) {
        return Session.builder().id(po.getId()).name(po.getName()).workspaceId(po.getWorkspaceId())
                .version(po.getVersion() == null ? 1L : po.getVersion())
                .historyRevision(po.getHistoryRevision() == null ? 1L : po.getHistoryRevision())
                .rootSessionId(po.getRootSessionId())
                .agentId(po.getAgentId())
                .teamId(po.getTeamId())
                .contextTokenCount(po.getContextTokenCount())
                .contextMaxTokens(po.getContextMaxTokens())
                .contextRatio(po.getContextRatio() == null ? null : po.getContextRatio().doubleValue())
                .createTime(po.getCreateTime()).updateTime(po.getUpdateTime())
                .build();
    }

    @Override
    protected @NotNull BaseMapper<SessionPO> mapper() {
        return sessionMapper;
    }
}

package com.summit.dp.session.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@RequiredArgsConstructor
@Repository
public class SessionContextRepositoryImpl extends AbstractRepository<SessionContext, SessionContextPO,Long> implements SessionContextRepository {


    private final SessionContextMapper sessionContextMapper;

    @Override
    protected SessionContextPO toPO(SessionContext entity) {
        return SessionContextPO.builder()
                .sessionId(entity.getSessionId())
                .content(entity.getContent())
                .version(entity.getVersion())
                .createTime(entity.getCreateTime())
                .updateTime(entity.getUpdateTime())
                .build();
    }

    @Override
    protected SessionContext toModel(SessionContextPO po) {
        return SessionContext.builder()
                .sessionId(po.getSessionId())
                .content(po.getContent())
                .version(po.getVersion())
                .createTime(po.getCreateTime())
                .updateTime(po.getUpdateTime())
                .build();
    }

    @Override
    protected BaseMapper<SessionContextPO> mapper() {
        return sessionContextMapper;
    }

    @Override
    public void batchDeleteBySessionIds(List<Long> sessionIds) {
        mapper().delete(new LambdaQueryWrapper<SessionContextPO>().in(SessionContextPO::getSessionId, sessionIds));
    }

    /**
     * 只显式取 {@code session_id} 与 {@code version}：正文列可能几十 MB，替换正文时读它纯属浪费。
     *
     * <p>用 LambdaQueryWrapper 的 {@code select} 而不是自定义 SQL —— MyBatis-Plus 会按
     * {@code @TableField} 生成实体 resultMap，列名映射不依赖全局驼峰开关。</p>
     */
    @Override
    public Optional<SessionContext> findSummary(Long sessionId) {
        if (sessionId == null) {
            return Optional.empty();
        }
        SessionContextPO row = sessionContextMapper.selectOne(new LambdaQueryWrapper<SessionContextPO>()
                .select(SessionContextPO::getSessionId, SessionContextPO::getVersion)
                .eq(SessionContextPO::getSessionId, sessionId));
        return row == null ? Optional.empty()
                : Optional.of(SessionContext.restoreSummary(row.getSessionId(), row.getVersion()));
    }
}

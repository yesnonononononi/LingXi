package com.summit.dp.session.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.List;

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
    protected @NotNull BaseMapper<SessionContextPO> mapper() {
        return sessionContextMapper;
    }

    @Override
    public void batchDeleteBySessionIds(List<Long> sessionIds) {
        mapper().delete(new LambdaQueryWrapper<SessionContextPO>().in(SessionContextPO::getSessionId, sessionIds));
    }
}

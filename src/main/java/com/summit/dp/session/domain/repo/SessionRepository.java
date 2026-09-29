package com.summit.dp.session.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.Session;

import java.util.List;

/** session 表仓储，只负责会话元数据。 */
public interface SessionRepository extends RepositoryTemplate<Session, Long> {
    Long saveAndReturnId(Session session);

    /** 根会话分页：过滤掉子代理会话，避免同一次委派在列表里重复出现。 */
    IPage<Session> queryRootPage(int current, int size);

    /** 会话树：根会话自身 + 其下全部子会话，平铺返回（按主键升序）。 */
    List<Session> findSessionTree(Long rootSessionId);

    /** 删除 {@code id} 所属的整棵会话树（自动把子会话 id 解析成根会话），返回被删的会话 id。 */
    List<Long> delSessionTreeByRootSId(Long id);
}

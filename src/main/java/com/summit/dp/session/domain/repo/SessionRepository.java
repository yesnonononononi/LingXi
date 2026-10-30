package com.summit.dp.session.domain.repo;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.session.domain.model.Session;

import java.util.List;
import java.util.Optional;

/** session 表仓储，只负责会话元数据。 */
public interface SessionRepository extends RepositoryTemplate<Session, Long> {
    Long saveAndReturnId(Session session);

    Optional<Session> lockById(Long sessionId);

    /**
     * 条件置已读：只有「当前未读」且（给出期望版本时）版本匹配才写入。
     *
     * <p>SQLite 没有行锁，{@link #lockById} 已退化为普通读；「已读」这个写入改用单语句条件更新，
     * 既不需要先读再写（单写者下读后升写会抢不到锁），也不会覆盖别人刚提交的新版本。</p>
     *
     * @param sessionId       会话标识
     * @param expectedVersion 调用方看到的版本；{@code null} 表示不校验版本
     * @return 是否真的改成了已读（{@code false} = 已是已读、版本已变化或会话不存在）
     */
    boolean markReadIfUnread(Long sessionId, Long expectedVersion);

    void updateRead(Session session);

    List<Session> findRootSessions();

    /** 根会话分页：过滤掉子代理会话，避免同一次委派在列表里重复出现。 */
    IPage<Session> queryRootPage(int current, int size);

    /** 会话树：根会话自身 + 其下全部子会话，平铺返回（按主键升序）。 */
    List<Session> findSessionTree(Long rootSessionId);

    /**
     * 按「根会话 + Agent」取已存在的子代理会话。
     *
     * <p>这是「主理人委派时优先复用而非无脑派生」的反查入口：同一根会话下同一 Agent 只应有一个
     * 子会话，命中则复用其上下文继续对话。取最新一条（id 倒序）：历史数据若因旧逻辑产生过重复
     * 子会话，复用的应是用户最近在用的那个。</p>
     *
     * @param rootSessionId 根会话 id
     * @param agentId       子 Agent id
     * @return 命中的子会话；不存在时为 {@link Optional#empty()}
     */
    Optional<Session> findByRootAndAgent(Long rootSessionId, Long agentId);

    /** 删除 {@code id} 所属的整棵会话树（自动把子会话 id 解析成根会话），返回被删的会话 id。 */
    List<Long> delSessionTreeByRootSId(Long id);
}
